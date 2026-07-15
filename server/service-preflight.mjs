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
 * Coerce the internal `gh` probe state into a value the wire contract accepts.
 * Until the background probe resolves, the server holds a transient "pending"
 * sentinel — outside {ready|missing|unauthenticated}, which the popup coerces
 * to "missing" and thus mislabels an installed, authenticated CLI as absent.
 * Report the non-alarming "unauthenticated" until the probe lands; it flips to
 * the real state within the probe timeout.
 *
 * @param {"pending" | "ready" | "missing" | "unauthenticated"} ghState
 * @returns {"ready" | "missing" | "unauthenticated"}
 */
export function publishedGhState(ghState) {
	return ghState === "pending" ? "unauthenticated" : ghState;
}

/**
 * Resolve transcription readiness from the selected provider.
 * The local engine takes precedence and is reported as "local" so /health
 * distinguishes the LITE default from the BYO AssemblyAI cloud path ("ready").
 *
 * @param {object} input
 * @param {string | undefined} input.apiKey
 * @param {() => Promise<boolean>} input.detectLocal
 * @returns {Promise<"ready" | "local" | "unconfigured">}
 */
export async function detectTranscriptionState({ apiKey, detectLocal }) {
	if (await detectLocal()) return "local";
	if (typeof apiKey === "string" && apiKey.length > 0) return "ready";
	return "unconfigured";
}

/**
 * Assemble the exact /health contract:
 * { ok: true, issues: boolean, repos: number, gh, transcription, originAllowed }.
 *
 * @param {object} input
 * @param {boolean} input.issues
 * @param {number} input.repos
 * @param {"ready" | "missing" | "unauthenticated"} input.gh
 * @param {"ready" | "local" | "unconfigured"} input.transcription
 * @param {boolean} input.originAllowed
 */
export function buildHealthPayload({
	issues,
	repos,
	gh,
	transcription,
	originAllowed,
}) {
	return {
		ok: true,
		issues: Boolean(issues),
		repos,
		gh,
		transcription,
		originAllowed: Boolean(originAllowed),
	};
}
