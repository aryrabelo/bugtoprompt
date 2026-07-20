/**
 * Streaming-token resolver for the overlay session engine.
 *
 * Resolution order (first match wins; throws if nothing succeeds so that
 * useSession's existing try/catch can degrade gracefully to batch transcription):
 *
 *  1. window.__BUGTOPROMPT__.streamingToken          — pre-minted temp token (most reliable)
 *  2. window.__BUGTOPROMPT__.mintStreamingToken()    — host-provided minter (e.g. an
 *                                                       extension worker that bypasses page CORS)
 *  3. client.mintStreamingToken()                    — server/dev path (default)
 */

import type { BugToPromptClient } from "../client";

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
 * SSR / jsdom-safe: `window` is guarded before use.
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
		(await tryServerMint(client, targetId))
	);
}
