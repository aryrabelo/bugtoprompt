/**
 * The SnapPromptClient seam — the only thing the overlay needs from its host.
 * The package ships a plain-fetch reference implementation; host applications
 * may substitute their own (tRPC, GraphQL, etc.) as long as it satisfies the
 * interface.
 */
import type { CaptureArtifact } from "../schema";

export interface Target {
	id: string;
	name: string;
	branch: string;
}

export interface SnapPromptClient {
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

async function postJson<T>(
	url: string,
	body: Record<string, unknown>,
): Promise<T> {
	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
	return res.json() as Promise<T>;
}

/**
 * A reference HTTP implementation over `fetch`. Maps each SnapPromptClient
 * method to the documented REST contract at `baseUrl`.
 *
 * Paths: POST /streaming-token, POST /artifact, POST /transcribe,
 *        POST /issue, GET /targets?projectId=
 */
export function createFetchClient(baseUrl: string): SnapPromptClient {
	return {
		mintStreamingToken(targetId?: string) {
			const body: Record<string, unknown> = {};
			if (targetId !== undefined) body.targetId = targetId;
			return postJson(`${baseUrl}/streaming-token`, body);
		},

		saveArtifact(input) {
			return postJson(`${baseUrl}/artifact`, {
				artifact: input.artifact,
				audioBase64: input.audioBase64,
				screenshotsBase64: input.screenshotsBase64,
			});
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
	createLocalFallbackClient,
	fetchServerConfig,
	resolveBaseUrl,
	type SnapPromptServerConfig,
} from "../overlay/autoConfig";
