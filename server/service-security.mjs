// Security helpers for the reference issue service. Pure + side-effect-free so
// they are unit-testable without booting the HTTP server.

/** Client session ids are minted as `cap_<uuid>` (see src/overlay/useSession.ts).
 *  Reject anything else BEFORE using it in a filesystem path (path-traversal guard). */
export function isValidSessionId(s) {
	return typeof s === "string" && /^cap_[A-Za-z0-9-]+$/.test(s);
}

/** A persisted screenshot filename is a bare `snap-NNNN.jpg` basename. Reject
 *  anything else (path separators, other extensions, invented names) BEFORE
 *  using it as a filesystem path, so the screenshotRef in the prompt, artifact
 *  JSON, JPEG, and issue-local path stay byte-identical. */
export function isValidScreenshotRef(s) {
	return (
		typeof s === "string" && /^snap-(?:[0-9]{4}|[1-9][0-9]{4,})\.jpg$/.test(s)
	);
}

/** Parse BUGTOPROMPT_ALLOWED_ORIGINS (comma-separated exact origins) into a Set. */
export function parseAllowedOrigins(env) {
	const raw = env?.BUGTOPROMPT_ALLOWED_ORIGINS || "";
	return new Set(
		raw
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean),
	);
}

/** A browser Origin is allowed when it is a localhost/127.0.0.1 dev origin (any
 *  port, http/https), a Tauri webview origin, or an explicit allowlisted origin.
 *  Returns true for falsy origin (non-browser clients send no Origin header). */
export function isOriginAllowed(origin, allowSet) {
	if (!origin) return true; // curl / server-to-server: no Origin to forge
	if (allowSet?.has(origin)) return true;
	if (origin === "tauri://localhost" || origin === "https://tauri.localhost")
		return true;
	try {
		const u = new URL(origin);
		return u.hostname === "localhost" || u.hostname === "127.0.0.1";
	} catch {
		return false;
	}
}
