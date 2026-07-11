/**
 * Build the BugToPrompt MV3 extension into extension/dist/.
 *
 * Assumes the root global JS/CSS were already produced by `npm run build`
 * (build:extension chains it first). Bundles the dependency-free extension
 * chrome (background/content/popup/options) with tsup, then copies the
 * manifest, HTML, CSS, icons, and the packaged standalone assets into dist/.
 */
import {
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "tsup";

const here = dirname(fileURLToPath(import.meta.url));
const extDir = dirname(here);
const root = dirname(extDir);
const dist = join(extDir, "dist");
const rootDist = join(root, "dist");
const globalJs = join(rootDist, "bugtoprompt.global.js");
const globalCss = join(rootDist, "bugtoprompt.css");
if (!existsSync(globalJs) || !existsSync(globalCss)) {
	throw new Error(
		"Missing dist/bugtoprompt.global.js or dist/bugtoprompt.css. Run `npm run build` first.",
	);
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

await build({
	entry: {
		background: join(extDir, "src/background.ts"),
		content: join(extDir, "src/content.ts"),
		popup: join(extDir, "src/popup.ts"),
		options: join(extDir, "src/options.ts"),
	},
	format: ["iife"],
	globalName: "BugToPromptExt",
	splitting: false,
	outExtension: () => ({ js: ".js" }),
	platform: "browser",
	target: "es2022",
	minify: true,
	dts: false,
	clean: false,
	silent: true,
	external: [],
	outDir: dist,
});

// Stamp the manifest version from package.json so it never drifts: Chrome's
// `version` must be dotted integers (strip the prerelease suffix), while
// `version_name` carries the full beta string.
const pkgVersion = JSON.parse(
	readFileSync(join(root, "package.json"), "utf8"),
).version;
const manifest = JSON.parse(
	readFileSync(join(extDir, "manifest.json"), "utf8"),
);
manifest.version = pkgVersion.split("-")[0];
manifest.version_name = pkgVersion;
writeFileSync(
	join(dist, "manifest.json"),
	`${JSON.stringify(manifest, null, "\t")}\n`,
);

for (const file of ["popup.html", "popup.css", "options.html", "options.css"]) {
	copyFileSync(join(extDir, file), join(dist, file));
}
cpSync(join(extDir, "icons"), join(dist, "icons"), { recursive: true });
copyFileSync(globalJs, join(dist, "bugtoprompt.global.js"));

console.log(`Extension built → ${dist}`);
