/**
 * MAIN-world half of the PRO bridge (P0 fix, issue #82). Before this, the
 * extension seeded the raw Bearer token straight into
 * `window.__BUGTOPROMPT__.pro.token` — a page-accessible global any page
 * script could read and replay. Now the extension seeds only
 * `{ baseUrl, bridged: true }` (no token) and every authenticated call is
 * relayed through `window.postMessage` to the extension's ISOLATED-world
 * content script, which forwards it to the service worker where the real
 * token is attached. The token never touches page-accessible JS.
 *
 * Message contract (frozen, shared with the extension lane):
 *   request:  { type: "btp:pro-request",  id, op, payload }
 *   response: { type: "btp:pro-response", id, ok, result?, error? }
 */

import type { BugToPromptClient, Target } from "./index";

const REQUEST_TYPE = "btp:pro-request";
const RESPONSE_TYPE = "btp:pro-response";
const TIMEOUT_MS = 120_000;

let nextId = 0;

interface ProResponseMessage {
	type: typeof RESPONSE_TYPE;
	id: string;
	ok: boolean;
	result?: unknown;
	error?: string;
}

function isProResponse(data: unknown): data is ProResponseMessage {
	return (
		typeof data === "object" &&
		data !== null &&
		"type" in data &&
		data.type === RESPONSE_TYPE
	);
}

/**
 * Post one PRO op through the postMessage relay and await the matching
 * response. Rejects on timeout, a `ok:false` reply, or the SW never seeing
 * the message. Always tears down its listener/timer on settle so a page
 * that outlives many requests never accumulates dangling listeners.
 */
function bridgeRequest<T>(op: string, payload: unknown): Promise<T> {
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
			if (!isProResponse(data) || data.id !== id) return;
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
