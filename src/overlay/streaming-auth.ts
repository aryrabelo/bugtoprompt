/**
 * Streaming-token resolver for the overlay session engine.
 *
 * Resolution order (first match wins; throws if nothing succeeds so that
 * useSession's existing try/catch can degrade gracefully to batch transcription):
 *
 *  1. window.__BUGTOPROMPT__.streamingToken          — pre-minted temp token (most reliable)
 *  2. window.__BUGTOPROMPT__.mintStreamingToken()    — host-provided minter (e.g. an
 *                                                       extension worker that bypasses page CORS)
 *  3. window.__BUGTOPROMPT__.assemblyAiKey / stored  — direct browser v3 mint (CORS-restricted)
 *  4. client.mintStreamingToken()                    — server/dev path (default)
 */

import type { BugToPromptClient } from "../client";
import { loadAssemblyKey } from "./key-store";

const ASSEMBLYAI_TOKEN_URL = "https://streaming.assemblyai.com/v3/token";

/**
 * Resolve a short-lived AssemblyAI streaming token using the best available
 * source for this tab.
 *
 * SSR / jsdom-safe: `window` and `fetch` are guarded before use.
 */
export async function resolveStreamingToken(
	client: BugToPromptClient,
	targetId?: string,
): Promise<string> {
	if (typeof window !== "undefined") {
		const hint = window.__BUGTOPROMPT__;

		// 1. Pre-minted token — no round-trip, no CORS concern.
		if (hint?.streamingToken) {
			return hint.streamingToken;
		}

		// 2. Host-provided async minter. A browser-extension background worker
		//    (or a local daemon page-hook) mints the token where CORS does not
		//    apply, then hands it back. Preferred over the in-page key mint.
		if (typeof hint?.mintStreamingToken === "function") {
			try {
				const token = await hint.mintStreamingToken();
				if (token) return token;
			} catch {
				// Fall through to the remaining sources.
			}
		}

		// 3. AssemblyAI API key — direct browser v3 mint. NOTE: AssemblyAI's token
		//    endpoint does NOT permit browser CORS (preflight returns 405), so this
		//    only succeeds behind a CORS-permitting proxy. Kept as a last resort
		//    before the server path; the key never leaves this browser.
		const key = hint?.assemblyAiKey ?? (await loadAssemblyKey());
		if (key) {
			try {
				if (typeof fetch === "undefined") {
					throw new Error("fetch not available");
				}
				const res = await fetch(
					`${ASSEMBLYAI_TOKEN_URL}?expires_in_seconds=300`,
					{ headers: { Authorization: key } },
				);
				if (!res.ok) {
					throw new Error(`AssemblyAI token mint failed: ${res.status}`);
				}
				const data = (await res.json()) as { token?: string };
				if (data.token) {
					return data.token;
				}
				throw new Error("AssemblyAI token response missing .token field");
			} catch {
				// Fall through to server mint.
			}
		}
	}

	// 4. Server-side mint — the dev / server path (default when no window hint).
	const { token } = await client.mintStreamingToken(targetId);
	return token;
}
