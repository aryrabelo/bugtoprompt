/**
 * Zip extension/dist/ into extension/bugtoprompt-extension-<version>.zip.
 * Assumes build.mjs already produced dist/. Uses the system `zip` (macOS/Linux)
 * to avoid adding an archiver dependency to this local-dev tool.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const extDir = dirname(here);
const root = dirname(extDir);
const dist = join(extDir, "dist");

if (!existsSync(join(dist, "manifest.json"))) {
	throw new Error(
		"extension/dist is not built. Run `npm run build:extension` first.",
	);
}

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const zipName = `bugtoprompt-extension-${pkg.version}.zip`;
const zipPath = join(extDir, zipName);

rmSync(zipPath, { force: true });
execFileSync("zip", ["-r", "-q", zipPath, "."], { cwd: dist });

console.log(`Packed → ${zipPath}`);
