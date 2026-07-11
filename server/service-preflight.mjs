/**
 * Preflight helpers for the BugToPrompt sidecar's self-diagnosing /health
 * endpoint. Pure, dependency-injected functions so the `gh` states and the
 * exact health payload can be unit-tested without touching the real user
 * account or spawning processes. See github-issue-service.mjs for wiring.
 */

/**
 * Resolve the `gh` CLI availability + auth WITHOUT ever surfacing a token.
 *
 * @param {object} deps
 * @param {() => Promise<boolean>} deps.lookup  resolves true when `gh` exists.
 * @param {() => Promise<unknown>} deps.authStatus  runs `gh auth status`;
 *        resolves when authenticated, rejects otherwise.
 * @returns {Promise<"ready" | "missing" | "unauthenticated">}
 */
export async function detectGhState({ lookup, authStatus }) {
	let present = false;
	try {
		present = await lookup();
	} catch {
		present = false;
	}
	if (!present) return "missing";
	try {
		await authStatus();
		return "ready";
	} catch {
		return "unauthenticated";
	}
}

/**
 * Resolve transcription readiness from the presence of an AssemblyAI key.
 * Missing credentials are non-fatal — capture, issues, and clipboard stay live.
 *
 * @param {string | undefined} apiKey
 * @returns {"ready" | "unconfigured"}
 */
export function detectTranscriptionState(apiKey) {
	return typeof apiKey === "string" && apiKey.length > 0
		? "ready"
		: "unconfigured";
}

/**
 * Assemble the exact /health contract:
 * { ok: true, issues: boolean, repos: number, gh, transcription }.
 *
 * @param {object} input
 * @param {boolean} input.issues
 * @param {number} input.repos
 * @param {"ready" | "missing" | "unauthenticated"} input.gh
 * @param {"ready" | "unconfigured"} input.transcription
 */
export function buildHealthPayload({ issues, repos, gh, transcription }) {
	return {
		ok: true,
		issues: Boolean(issues),
		repos,
		gh,
		transcription,
	};
}
