import { describe, expect, it } from "vitest";
import { isVersionNotFound } from "./npm-view-not-found.mjs";

describe("isVersionNotFound", () => {
	it("returns true for npm's version-specific 404 on a known package", () => {
		const stderr =
			"npm error code E404\n" +
			"npm error 404 No match found for version 0.14.0-beta.6\n" +
			"npm error 404  'bugtoprompt@0.14.0-beta.6' is not in this registry.\n";

		expect(isVersionNotFound(stderr, "0.14.0-beta.6")).toBe(true);
	});

	it("returns false for a package-level 404 (wrong name / registry) — the actual bug fix", () => {
		// The OLD broad regex matched `404 Not Found` and `is not in this
		// registry` here and wrongly proceeded to publish. This stderr lacks the
		// version-specific "No match found for version" string.
		const stderr =
			"npm error code E404\n" +
			"npm error 404 Not Found - GET https://registry.npmjs.org/some-other-pkg - Not found\n" +
			"npm error 404 'some-other-pkg@0.14.0-beta.6' is not in this registry.\n";

		expect(isVersionNotFound(stderr, "0.14.0-beta.6")).toBe(false);
	});

	it("returns false when a DIFFERENT version's 'No match found' is reported", () => {
		const stderr = "npm error 404 No match found for version 1.2.3\n";

		expect(isVersionNotFound(stderr, "1.2.4")).toBe(false);
	});

	it("escapes literal dots so the regex metachar can't over-match", () => {
		const stderr = "npm error 404 No match found for versionX0X14X0-betaX6\n";

		expect(isVersionNotFound(stderr, "0.14.0-beta.6")).toBe(false);
	});
});
