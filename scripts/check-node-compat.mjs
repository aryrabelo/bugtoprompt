#!/usr/bin/env node
/**
 * Regression guard for #14/#16: fails if `Promise.withResolvers()` (ES2024,
 * requires Node >=22) shows up in src/ outside the documented Node-18 shim,
 * so CI catches it before it breaks the Node 20/22 matrix again.
 *
 * Usage: node scripts/check-node-compat.mjs
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// Scripts and tests both run from the package root (npm/pnpm scripts, and
// vitest's default `root`), so cwd is a reliable, transform-safe stand-in
// for `import.meta.url` (which vitest doesn't always resolve to a real
// `file:` URL for non-test modules).
function repoRoot() {
	return process.cwd();
}

// A line whose trimmed content starts with a comment marker is exempt — the
// Node-18 shim documents the exact API it replaces in a doc comment, and
// that's the only mention allowed to survive this guard.
const COMMENT_LINE = /^(\/\/|\/\*|\*)/;

export function findWithResolversUsages(dir, base) {
	const effectiveBase = dir === undefined ? repoRoot() : base;
	const effectiveDir = dir === undefined ? join(effectiveBase, "src") : dir;
	const hits = [];
	for (const entry of readdirSync(effectiveDir)) {
		const full = join(effectiveDir, entry);
		const stat = statSync(full);
		if (stat.isDirectory()) {
			hits.push(...findWithResolversUsages(full, effectiveBase));
			continue;
		}
		if (!/\.(ts|tsx)$/.test(entry)) continue;
		const relPath = relative(effectiveBase, full).split("\\").join("/");
		const lines = readFileSync(full, "utf8").split("\n");
		for (let i = 0; i < lines.length; i++) {
			if (COMMENT_LINE.test(lines[i]?.trim() ?? "")) continue;
			if (lines[i].includes("Promise.withResolvers")) {
				hits.push(`${relPath}:${i + 1}`);
			}
		}
	}
	return hits;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const hits = findWithResolversUsages();
	if (hits.length > 0) {
		console.error(
			"Promise.withResolvers() (ES2024, requires Node >=22) found outside " +
				"the Node-18 shim:\n" +
				hits.map((h) => `  ${h}`).join("\n") +
				"\nUse deferred() from src/overlay/util/deferred.ts instead (see #14, #16).",
		);
		process.exit(1);
	}
	console.log(
		"OK: no Promise.withResolvers() usage outside src/overlay/util/deferred.ts",
	);
}
