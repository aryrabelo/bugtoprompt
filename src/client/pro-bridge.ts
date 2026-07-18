/**
 * MAIN-world half of the PRO bridge, wire contract v2.1 (issue #82, findings
 * 2+4, plus the round-2 hardening findings 3608422578/3608422580). Originally
 * the extension seeded the raw Bearer token straight into
 * `window.__BUGTOPROMPT__.pro.token` — a page-accessible global any page
 * script could read and replay. Contract v1 fixed that by relaying every
 * authenticated call through `window.postMessage` to the extension's
 * ISOLATED-world content script (which forwards it to the service worker,
 * where the real token is attached) — but a passive page listener could
 * still read every plaintext request/response, including capture audio and
 * screenshot bytes.
 *
 * Contract v2 layered end-to-end encryption on top of the same relay:
 *  - The service worker mints a fresh per-relay-initialization secret and
 *    hands it to this module's `window.__btpProBridgeSecret.set()` hook via
 *    a second `chrome.scripting.executeScript` call — never over
 *    `window.postMessage`. Page scripts cannot observe executeScript
 *    evaluation, so a passive listener never sees the secret.
 *  - Every request/response payload is sealed with AES-GCM under a key
 *    derived from that secret (`importKey(SHA-256(secret))`); only the
 *    extension's ISOLATED-world relay, which received the identical secret,
 *    can decrypt it.
 *  - A forged or garbled response — wrong key, corrupt envelope, or a
 *    plaintext shape while encrypted mode is active — simply fails to
 *    decrypt/parse and is dropped; the listener keeps waiting for the
 *    genuine encrypted reply instead of settling early on an attacker's
 *    message.
 *
 * Contract v2.1 adds two more layers on top of v2:
 *  - AAD id+direction binding: every AES-GCM operation passes
 *    `additionalData`, bound to the message's own wire id and direction —
 *    `"btp:req:" + id` for requests, `"btp:res:" + id` for responses. A
 *    genuinely-encrypted response recorded from one exchange and replayed
 *    (rebound) under a different request's id now fails GCM authentication
 *    and is dropped exactly like a forged one, instead of decrypting cleanly
 *    under the shared key and resolving the wrong request.
 *  - Fail-closed on secure pages: when `crypto.subtle` exists but no secret
 *    has been delivered yet, every op now rejects locally and NEVER touches
 *    `window.postMessage` — the legacy plaintext relay is reserved
 *    exclusively for contexts that genuinely lack `crypto.subtle` (insecure
 *    origins), never as a "subtle but no secret yet" fallback.
 *  - Request ids are `crypto.randomUUID()` in encrypted mode (unguessable,
 *    unlike the old predictable counter+timestamp scheme), falling back to
 *    the legacy counter only if `randomUUID` is unavailable.
 *
 * Degraded mode: on an insecure origin (non-loopback plain-http), neither
 * world has `crypto.subtle`, so encryption is impossible on both ends. This
 * module then falls back to the v1 plaintext relay — except `op ===
 * "saveArtifact"`, which carries raw capture audio/screenshot bytes and
 * refuses outright rather than ever send them over a page-visible channel
 * (`useSession` already treats a `saveArtifact` failure as non-fatal).
 *
 * Residual (documented, not fixable from MAIN world): the secret setter and
 * every crypto primitive here run in the same MAIN world as the host page.
 * A page that pre-wraps `window.__btpProBridgeSecret.set` — or monkey-patches
 * `crypto.subtle` itself — before the secret arrives can still intercept it.
 * MAIN-world code cannot defend against an active MAIN-world attacker; the
 * encrypted channel's job is closing the *passive* observation gap, not
 * sandboxing against active page script.
 *
 * Message contract (frozen, shared with the extension lane — full spec in
 * bridge-contract-v2 + bridge-contract-v2.1):
 *   encrypted request:  { type: "btp:pro-request",  id, enc }
 *     enc plaintext = JSON.stringify({ op, payload }), AAD = "btp:req:" + id
 *   encrypted response: { type: "btp:pro-response", id, enc }
 *     enc plaintext = JSON.stringify({ ok, result?, error? }), AAD = "btp:res:" + id
 *   legacy plaintext (degraded contexts only, no crypto.subtle):
 *     request:  { type: "btp:pro-request",  id, op, payload }
 *     response: { type: "btp:pro-response", id, ok, result?, error? }
 */

import type { BugToPromptClient, Target } from "./index";

const REQUEST_TYPE = "btp:pro-request";
const RESPONSE_TYPE = "btp:pro-response";
const TIMEOUT_MS = 120_000;

let nextId = 0;

// ---------------------------------------------------------------------------
// Secret + key management (contract v2)
// ---------------------------------------------------------------------------

// Module-scope only — the secret must NEVER be stored on `window` or any
// other page-reachable object. Only the setter closure below can write it,
// and nothing reads it back out through `window.__btpProBridgeSecret`.
let bridgeSecret: string | undefined;
// Derived AES-GCM key for the current `bridgeSecret`, memoized so repeat
// requests don't re-hash + re-import on every call. Invalidated on `set()`.
let cachedKeyPromise: Promise<CryptoKey> | undefined;

declare global {
	interface Window {
		/** Contract v2 secret-delivery hook. Registered by this module at
		 *  load time; the service worker calls it exactly once per relay
		 *  initialization via `executeScript`, passing a freshly minted
		 *  secret as a closure argument (never over `postMessage`). Write-only
		 *  from the page's perspective — there is no getter. */
		__btpProBridgeSecret?: { set(secret: string): void };
	}
}

if (typeof window !== "undefined") {
	window.__btpProBridgeSecret = {
		set(secret: string): void {
			if (typeof secret !== "string" || secret === "") return;
			bridgeSecret = secret;
			cachedKeyPromise = undefined;
		},
	};
}

function deriveKey(secret: string): Promise<CryptoKey> {
	if (!cachedKeyPromise) {
		cachedKeyPromise = crypto.subtle
			.digest("SHA-256", new TextEncoder().encode(secret))
			.then((raw) =>
				crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
					"encrypt",
					"decrypt",
				]),
			);
	}
	return cachedKeyPromise;
}

interface Envelope {
	iv: string;
	data: string;
}

function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

async function encryptEnvelope(
	key: CryptoKey,
	plaintext: string,
	aad: string,
): Promise<Envelope> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ct = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) },
		key,
		new TextEncoder().encode(plaintext),
	);
	return { iv: toBase64(iv), data: toBase64(new Uint8Array(ct)) };
}

async function decryptEnvelope(
	key: CryptoKey,
	enc: Envelope,
	aad: string,
): Promise<string> {
	const pt = await crypto.subtle.decrypt(
		{
			name: "AES-GCM",
			iv: fromBase64(enc.iv),
			additionalData: new TextEncoder().encode(aad),
		},
		key,
		fromBase64(enc.data),
	);
	return new TextDecoder().decode(pt);
}

function isEnvelope(x: unknown): x is Envelope {
	return (
		typeof x === "object" &&
		x !== null &&
		typeof (x as Record<string, unknown>).iv === "string" &&
		typeof (x as Record<string, unknown>).data === "string"
	);
}

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

interface LegacyProResponseMessage {
	type: typeof RESPONSE_TYPE;
	id: string;
	ok: boolean;
	result?: unknown;
	error?: string;
}

function isLegacyProResponse(data: unknown): data is LegacyProResponseMessage {
	return (
		typeof data === "object" &&
		data !== null &&
		"type" in data &&
		data.type === RESPONSE_TYPE
	);
}

interface EncryptedProResponseMessage {
	type: typeof RESPONSE_TYPE;
	id: string;
	enc: Envelope;
}

function isEncryptedProResponse(
	data: unknown,
): data is EncryptedProResponseMessage {
	if (typeof data !== "object" || data === null) return false;
	const d = data as Record<string, unknown>;
	return (
		d.type === RESPONSE_TYPE && typeof d.id === "string" && isEnvelope(d.enc)
	);
}

interface ResponseBody {
	ok: boolean;
	result?: unknown;
	error?: string;
}

function isResponseBody(x: unknown): x is ResponseBody {
	return (
		typeof x === "object" &&
		x !== null &&
		typeof (x as Record<string, unknown>).ok === "boolean"
	);
}

// ---------------------------------------------------------------------------
// Request paths
// ---------------------------------------------------------------------------

/**
 * Legacy (v1) plaintext relay — used only in degraded contexts, see the
 * module doc comment. Rejects on timeout, an `ok:false` reply, or the SW
 * never seeing the message. Always tears down its listener/timer on settle
 * so a page that outlives many requests never accumulates dangling
 * listeners.
 */
function legacyBridgeRequest<T>(op: string, payload: unknown): Promise<T> {
	// Unique per-request id — a counter (collision-proof within one page
	// load) plus a random suffix (collision-proof across concurrent
	// tabs/reloads racing the same millisecond).
	const id = `${Date.now()}-${nextId++}-${Math.random().toString(36).slice(2)}`;
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error(`PRO bridge timeout: ${op}`));
		}, TIMEOUT_MS);

		function cleanup(): void {
			clearTimeout(timer);
			window.removeEventListener("message", onMessage);
		}

		function onMessage(ev: MessageEvent): void {
			// Only trust messages the page itself posted (the relay content
			// script replies via the same `window`, not a foreign frame).
			if (ev.source !== window) return;
			const data: unknown = ev.data;
			if (!isLegacyProResponse(data) || data.id !== id) return;
			cleanup();
			if (data.ok) {
				resolve(data.result as T);
			} else {
				reject(new Error(data.error ?? `PRO bridge error: ${op}`));
			}
		}

		window.addEventListener("message", onMessage);
		window.postMessage({ type: REQUEST_TYPE, id, op, payload }, "/");
	});
}

/**
 * Contract v2 encrypted relay. Every request/response is an AES-GCM sealed
 * envelope bound (via AAD) to its own wire id and direction — a response
 * that doesn't decrypt to `{ok,result?,error?}` under the current key *and*
 * the expected `"btp:res:" + id` AAD — forged, corrupted, plaintext-shaped,
 * or a genuine response rebound from a different exchange — is silently
 * ignored so the request keeps waiting for the genuine reply (this is the
 * forged/rebind-response rejection, contract v2.1). Same timeout/listener
 * cleanup semantics as the legacy path.
 */
function encryptedBridgeRequest<T>(
	secret: string,
	op: string,
	payload: unknown,
): Promise<T> {
	// Contract v2.1 3a: unguessable per-request ids via randomUUID whenever
	// it's available (encrypted mode always implies crypto.subtle, so this
	// should be the case in practice); fall back to the old counter+random
	// suffix scheme otherwise.
	const id =
		typeof crypto.randomUUID === "function"
			? crypto.randomUUID()
			: `${Date.now()}-${nextId++}-${Math.random().toString(36).slice(2)}`;
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error(`PRO bridge timeout: ${op}`));
		}, TIMEOUT_MS);

		function cleanup(): void {
			clearTimeout(timer);
			window.removeEventListener("message", onMessage);
		}

		async function handleEncryptedResponse(enc: Envelope): Promise<void> {
			let body: unknown;
			try {
				const key = await deriveKey(secret);
				body = JSON.parse(await decryptEnvelope(key, enc, `btp:res:${id}`));
			} catch {
				// Wrong key, wrong AAD (a genuine response rebound onto a
				// different request's id), corrupt ciphertext, or non-JSON
				// plaintext — a forged/garbled/rebound response. Drop it and
				// keep listening.
				return;
			}
			if (!isResponseBody(body)) return;
			cleanup();
			if (body.ok) {
				resolve(body.result as T);
			} else {
				reject(new Error(body.error ?? `PRO bridge error: ${op}`));
			}
		}

		function onMessage(ev: MessageEvent): void {
			if (ev.source !== window) return;
			const data: unknown = ev.data;
			// Legacy plaintext-shaped responses are never trusted in
			// encrypted mode — only `enc` envelopes reach the decrypt path.
			if (!isEncryptedProResponse(data) || data.id !== id) return;
			void handleEncryptedResponse(data.enc);
		}

		async function send(): Promise<void> {
			try {
				const key = await deriveKey(secret);
				const enc = await encryptEnvelope(
					key,
					JSON.stringify({ op, payload }),
					`btp:req:${id}`,
				);
				window.postMessage({ type: REQUEST_TYPE, id, enc }, "/");
			} catch (err) {
				cleanup();
				reject(err instanceof Error ? err : new Error(String(err)));
			}
		}

		window.addEventListener("message", onMessage);
		void send();
	});
}

/**
 * Post one PRO op through the postMessage relay and await the matching
 * response. Chooses contract v2 (encrypted) whenever `crypto.subtle` is
 * available: with a delivered secret it uses the encrypted relay; without
 * one it fails closed locally (contract v2.1 3b) rather than ever falling
 * back to a page-visible plaintext send. The legacy plaintext path only
 * runs in genuinely degraded contexts lacking `crypto.subtle` entirely,
 * refusing `saveArtifact` outright there (see module doc comment).
 */
function bridgeRequest<T>(op: string, payload: unknown): Promise<T> {
	const subtleAvailable = typeof crypto !== "undefined" && !!crypto.subtle;
	if (subtleAvailable) {
		if (bridgeSecret) {
			return encryptedBridgeRequest<T>(bridgeSecret, op, payload);
		}
		return Promise.reject(
			new Error(
				"PRO bridge: encryption secret not established — refusing to send payload on a page-visible channel",
			),
		);
	}
	if (op === "saveArtifact") {
		return Promise.reject(
			new Error(
				"PRO bridge: refusing to send capture bytes over a page-visible channel (insecure context)",
			),
		);
	}
	return legacyBridgeRequest<T>(op, payload);
}

/**
 * BugToPromptClient implementation that relays every call through the
 * extension's MAIN-world <-> service-worker bridge instead of calling
 * `fetch` directly. Used whenever `window.__BUGTOPROMPT__.pro.bridged` is
 * true (see `useAutoConfig` in `../overlay/BugToPrompt.tsx`).
 */
export function createProBridgeClient(): BugToPromptClient {
	return {
		mintStreamingToken(targetId?: string) {
			return bridgeRequest("mintStreamingToken", { targetId });
		},

		saveArtifact(input) {
			return bridgeRequest("saveArtifact", input);
		},

		transcribeBatch(sessionId: string, targetId?: string) {
			return bridgeRequest("transcribeBatch", { sessionId, targetId });
		},

		createIssue(input) {
			return bridgeRequest("createIssue", input);
		},

		listTargets(projectId: string) {
			return bridgeRequest<Target[]>("listTargets", { projectId });
		},
	};
}
