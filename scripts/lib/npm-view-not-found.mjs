/**
 * True only when `stderr` from `npm view <pkg>@<version> ...` reports the
 * specific version is missing from an otherwise-known registry entry (npm's
 * "No match found for version X" 404). A package-level 404 (wrong name,
 * wrong registry, unpublished endpoint) does NOT match — callers that
 * already know the package exists must treat that as inconclusive and abort
 * instead of silently republishing (see issue #26 / PR #12 cubic review).
 */
export function isVersionNotFound(stderr, version) {
	const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`No match found for version ${escaped}`, "i").test(
		String(stderr),
	);
}
