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

type Hint = Window["__BUGTOPROMPT__"];

// ---------------------------------------------------------------------------
// Strategy helpers — each returns a token string or null (never throws).
// ---------------------------------------------------------------------------

async function tryPreMinted(hint: Hint): Promise<string | null> {
	return hint?.streamingToken || null;
}

async function tryHostMinter(hint: Hint): Promise<string | null> {
	if (typeof hint?.mintStreamingToken !== "function") return null;
	try {
		const token = await hint.mintStreamingToken();
		return token || null;
	} catch {
		return null;
	}
}

/** Direct browser v3 mint. NOTE: AssemblyAI's token endpoint does NOT permit
 *  browser CORS (preflight returns 405), so this only succeeds behind a
 *  CORS-permitting proxy. The key never leaves this browser. */
async function tryDirectKey(hint: Hint): Promise<string | null> {
	// loadAssemblyKey is only meaningful in a browser context; guard it to
	// preserve the original behaviour (SSR skips it, stays SSR-safe).
	const key =
		hint?.assemblyAiKey ??
		(typeof window !== "undefined" ? await loadAssemblyKey() : null);
	if (!key) return null;
	try {
		if (typeof fetch === "undefined") throw new Error("fetch not available");
		const res = await fetch(`${ASSEMBLYAI_TOKEN_URL}?expires_in_seconds=300`, {
			headers: { Authorization: key },
		});
		if (!res.ok) {
			throw new Error(`AssemblyAI token mint failed: ${res.status}`);
		}
		const data = (await res.json()) as { token?: string };
		if (data.token) return data.token;
		throw new Error("AssemblyAI token response missing .token field");
	} catch {
		// Fall through to server mint.
		return null;
	}
}

async function tryServerMint(
	client: BugToPromptClient,
	targetId?: string,
): Promise<string> {
	const { token } = await client.mintStreamingToken(targetId);
	return token;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

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
	const hint =
		typeof window !== "undefined" ? window.__BUGTOPROMPT__ : undefined;
	return (
		(await tryPreMinted(hint)) ??
		(await tryHostMinter(hint)) ??
		(await tryDirectKey(hint)) ??
		(await tryServerMint(client, targetId))
	);
}
