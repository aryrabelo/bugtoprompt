// @vitest-environment node
// Manifest host-permission invariant (issue #97: per-site runtime permission
// model). BugToPrompt grants no site access at install beyond loopback + the
// hosted API, then requests each non-localhost origin at capture time via
// chrome.permissions.request (popup.ts) — gated by permissions.contains
// (background.ts). Two halves of that contract live in the manifest and are
// easy to break silently, so this guard pins both:
//
//   1. host_permissions (install-time, granted with NO prompt) MUST stay
//      narrow. A broad pattern here (<all_urls>, http://*/*, https://*/*) is
//      the actual Chrome Web Store rejection risk the issue targets.
//   2. optional_host_permissions MUST keep http://*/* + https://*/*. Chrome
//      requires a matching wildcard in optional_host_permissions to grant an
//      origin "discovered at runtime" (developer.chrome.com/docs/extensions/
//      reference/api/permissions). Removing it does not tighten anything at
//      install (optional perms carry no install warning) — it silently breaks
//      per-site capture on every non-localhost site.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const extRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(
	readFileSync(join(extRoot, "manifest.json"), "utf8"),
) as {
	host_permissions?: string[];
	optional_host_permissions?: string[];
};

/** Patterns that grant access to arbitrary sites. */
const BROAD = ["<all_urls>", "http://*/*", "https://*/*", "*://*/*"];

describe("manifest host permissions (issue #97)", () => {
	it("keeps install-time host_permissions narrow (no broad grants)", () => {
		const hosts = manifest.host_permissions ?? [];
		for (const pattern of hosts) {
			expect(BROAD).not.toContain(pattern);
		}
		// Loopback + the hosted API are the only always-granted origins.
		expect(hosts).toContain("http://localhost/*");
		expect(hosts).toContain("http://127.0.0.1/*");
	});

	it("keeps http://*/* + https://*/* in optional_host_permissions so runtime per-site requests work", () => {
		const optional = manifest.optional_host_permissions ?? [];
		// Chrome only grants a runtime-discovered origin when a matching
		// wildcard scheme is declared here. Both schemes are required: dev
		// sites are commonly plain-HTTP (staging) and HTTPS (previews).
		expect(optional).toContain("http://*/*");
		expect(optional).toContain("https://*/*");
	});
});
