/**
 * The BugToPromptClient seam — the only thing the overlay needs from its host.
 * The package ships a plain-fetch reference implementation; host applications
 * may substitute their own (tRPC, GraphQL, etc.) as long as it satisfies the
 * interface.
 */

import type { CaptureArtifact } from "../schema";
import { debug } from "../shared/debug";

export interface Target {
	id: string;
	name: string;
	branch: string;
}

export interface BugToPromptClient {
	mintStreamingToken(
		targetId?: string,
	): Promise<{ token: string; expiresAt: number }>;
	saveArtifact(input: {
		artifact: CaptureArtifact;
		audioBase64: string;
		screenshotsBase64: string[];
	}): Promise<{ dir: string; sessionId: string }>;
	transcribeBatch(
		sessionId: string,
		targetId?: string,
	): Promise<{ transcript: CaptureArtifact["transcript"] }>;
	createIssue(input: {
		projectId: string;
		targetId?: string;
		sessionId: string;
		prompt: string;
	}): Promise<{ created: boolean; number: number; url: string }>;
	listTargets(projectId: string): Promise<Target[]>;
}

/** Encode a Blob as base64 (for the saveArtifact audio/screenshot payloads). */
export async function blobToBase64(blob: Blob): Promise<string> {
	const bytes = new Uint8Array(await blob.arrayBuffer());
	let binary = "";
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}

/** Decode a base64 string (no data-URL prefix) back to raw bytes for upload. */
function base64ToBytes(b64: string): Uint8Array {
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/**
 * Signals that a blob upload could not be completed — either the backend lacks
 * the /blob route (legacy/self-hosted: 404/405) or the upload was rejected
 * (413/429/5xx) or the request itself failed. The caller falls back to the
 * legacy base64 artifact payload once.
 */
class BlobRouteError extends Error {}

/**
 * POST one media blob to `{baseUrl}/blob?session=&kind=&seq=` as a raw binary
 * body. Returns the server ref on success; throws BlobRouteError on any failure
 * so the caller can degrade to the legacy path.
 */
async function uploadBlob(
	baseUrl: string,
	sessionId: string,
	kind: "screenshot" | "audio",
	seq: number,
	bytes: Uint8Array,
	contentType: string,
): Promise<string> {
	const url = `${baseUrl}/blob?session=${encodeURIComponent(sessionId)}&kind=${kind}&seq=${seq}`;
	let res: Response;
	try {
		res = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": contentType },
			// Uint8Array is a valid runtime BodyInit; the cast bridges a lib.dom/
			// @types/node typing gap where Uint8Array<ArrayBufferLike> is rejected.
			body: bytes as BodyInit,
		});
	} catch (err) {
		throw new BlobRouteError(`blob fetch failed: ${String(err)}`);
	}
	if (!res.ok) {
		debug("blob upload failed", { url, status: res.status, kind, seq });
		throw new BlobRouteError(`${res.status} ${res.statusText}`);
	}
	const { ref } = (await res.json()) as { ref: string };
	return ref;
}

async function postJson<T>(
	url: string,
	body: Record<string, unknown>,
): Promise<T> {
	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		debug("POST failed", {
			url,
			status: res.status,
			statusText: res.statusText,
		});
		const body = await res.text().catch(() => "");
		throw new Error(`${res.status} ${res.statusText}: ${body}`);
	}
	return res.json() as Promise<T>;
}

/**
 * A reference HTTP implementation over `fetch`. Maps each BugToPromptClient
 * method to the documented REST contract at `baseUrl`.
 *
 * Paths: POST /streaming-token, POST /artifact, POST /transcribe,
 *        POST /issue, GET /targets?projectId=
 */
export function createFetchClient(baseUrl: string): BugToPromptClient {
	return {
		mintStreamingToken(targetId?: string) {
			const body: Record<string, unknown> = {};
			if (targetId !== undefined) body.targetId = targetId;
			return postJson(`${baseUrl}/streaming-token`, body);
		},

		async saveArtifact(input) {
			const { artifact, audioBase64, screenshotsBase64 } = input;
			const shots = screenshotsBase64
				.map((b64, seq) => ({ b64, seq }))
				.filter((s) => s.b64.length > 0);
			const hasAudio = audioBase64.length > 0;

			// Empty capture: no media to stage, send an artifact-only payload.
			if (shots.length === 0 && !hasAudio) {
				return postJson(`${baseUrl}/artifact`, { artifact });
			}

			// New path: stage each blob via the binary /blob route, then reference
			// them from a slim artifact. Any blob failure (route absent, too large,
			// rate-limited, 5xx, network) degrades to the legacy base64 payload once.
			try {
				const screenshotRefs: string[] = [];
				for (const { b64, seq } of shots) {
					screenshotRefs.push(
						await uploadBlob(
							baseUrl,
							artifact.sessionId,
							"screenshot",
							seq,
							base64ToBytes(b64),
							"image/jpeg",
						),
					);
				}
				let audioRef: string | undefined;
				if (hasAudio) {
					audioRef = await uploadBlob(
						baseUrl,
						artifact.sessionId,
						"audio",
						0,
						base64ToBytes(audioBase64),
						"audio/webm",
					);
				}
				const body: Record<string, unknown> = { artifact };
				if (screenshotRefs.length > 0) body.screenshotRefs = screenshotRefs;
				if (audioRef !== undefined) body.audioRef = audioRef;
				return await postJson(`${baseUrl}/artifact`, body);
			} catch (err) {
				// A slim-artifact POST failure is a real error — surface it.
				if (!(err instanceof BlobRouteError)) throw err;
				// Blob staging unavailable: fall back to the legacy base64 payload.
				return postJson(`${baseUrl}/artifact`, {
					artifact,
					audioBase64,
					screenshotsBase64,
				});
			}
		},

		transcribeBatch(sessionId, targetId?) {
			const body: Record<string, unknown> = { sessionId };
			if (targetId !== undefined) body.targetId = targetId;
			return postJson(`${baseUrl}/transcribe`, body);
		},

		createIssue(input) {
			const body: Record<string, unknown> = {
				projectId: input.projectId,
				sessionId: input.sessionId,
				prompt: input.prompt,
			};
			if (input.targetId !== undefined) body.targetId = input.targetId;
			return postJson(`${baseUrl}/issue`, body);
		},

		async listTargets(projectId) {
			const url = `${baseUrl}/targets?projectId=${encodeURIComponent(projectId)}`;
			const res = await fetch(url);
			if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
			return res.json() as Promise<Target[]>;
		},
	};
}

export {
	type BugToPromptServerConfig,
	createLocalFallbackClient,
	fetchServerConfig,
	resolveBaseUrl,
} from "../overlay/autoConfig";
