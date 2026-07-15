// @vitest-environment node
// Identity invariant (issue #7 / E5-T1): the extension talks to the local
// bugtoprompt sidecar. The discontinued standalone package name must never
// reappear in the extension's shipped code or copy (source, HTML, CSS,
// manifest, README). Guards the migration against silent regression.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const extRoot = dirname(dirname(fileURLToPath(import.meta.url)));
// Built from parts so this guard file is not its own false positive.
const DISCONTINUED = ["bugtoprompt", "server"].join("-");

/** Human-authored, shipped extension files, excluding build output (dist/),
 *  binary icons, node_modules, and tests (not bundled). */
function sourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		if (name === "dist" || name === "node_modules" || name === "icons") {
			continue;
		}
		const full = join(dir, name);
		if (statSync(full).isDirectory()) {
			out.push(...sourceFiles(full));
			continue;
		}
		if (/\.test\.tsx?$/.test(name)) continue;
		if (/\.(ts|tsx|mjs|js|html|css|json|md)$/.test(name)) out.push(full);
	}
	return out;
}

describe("extension identity (issue #7)", () => {
	it("references no discontinued standalone-server package name anywhere", () => {
		const offenders = sourceFiles(extRoot).filter((file) =>
			readFileSync(file, "utf8").includes(DISCONTINUED),
		);
		expect(offenders).toEqual([]);
	});
});
