/**
 * One-shot STABLE release: verify → stamp the tray version → pack the extension
 * zip → build the tray DMG → publish npm and move `latest`, with ONE version
 * across all three (issue #92). Both artifacts are built BEFORE the irreversible
 * publish so a build failure aborts before `@latest` moves (cubic #109 P1).
 *
 * package.json `version` is the single source of truth. The extension manifest
 * is already stamped from it (extension/scripts/build.mjs); this script also
 * stamps sidecar-tray/Cargo.toml (and Cargo.lock) so the DMG carries the same
 * version — package-dmg.sh reads the version from Cargo.toml.
 *
 * Usage:
 *   npm run release:stable                        # publish package.json version
 *   npm run release:stable -- --set-version=0.14.1  # promote, then release
 *   npm run release:stable -- --otp=123456        # when npm enforces OTP (EOTP)
 *
 * Unlike release:beta this publishes to the DEFAULT dist-tag and then
 * explicitly moves `latest` to the released version — so a version previously
 * cut as a beta (already on the registry) is promoted to `latest` without a
 * duplicate publish.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isVersionNotFound } from "./lib/npm-view-not-found.mjs";
import {
	stampLockVersion,
	stampPackageVersion,
} from "./lib/stamp-cargo-version.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const trayDir = join(root, "sidecar-tray");

const args = process.argv.slice(2);
const otpArg = args.find((a) => a.startsWith("--otp="));
const setVersionArg = args.find((a) => a.startsWith("--set-version="));
const otpFlags = otpArg ? [otpArg] : [];

// Redact OTP in the echoed command so captured logs never retain the code,
// while still passing the original arguments through to execFileSync.
const run = (cmd, cmdArgs, cwd) => {
	const shown = cmdArgs.map((a) =>
		a.startsWith("--otp=") ? "--otp=<redacted>" : a,
	);
	console.log(`\n$ ${cmd} ${shown.join(" ")}  (${cwd})`);
	execFileSync(cmd, cmdArgs, { cwd, stdio: "inherit" });
};

const pkg = (dir) =>
	JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
const version = (dir) => pkg(dir).version;

// 0. Optional promotion: set the stable version before anything irreversible.
if (setVersionArg) {
	const next = setVersionArg.slice("--set-version=".length);
	run("npm", ["pkg", "set", `version=${next}`], root);
	console.log(`\nSet root package version → ${next}`);
}

const releaseVersion = version(root);

// Guard: a STABLE cut must never move `latest` to a prerelease. The beta flow
// leaves prerelease versions in package.json (e.g. 0.14.0-beta.6); publishing
// that as stable would be the inverse of issue #92. Require a stable semver
// (promote first with --set-version=X.Y.Z).
if (releaseVersion.includes("-")) {
	console.error(
		"Refusing to cut a stable release from prerelease version " +
			`"${releaseVersion}". Promote first, e.g.\n` +
			"  npm run release:stable -- --set-version=<stable X.Y.Z>",
	);
	process.exit(1);
}
console.log(`\nReleasing bugtoprompt ${releaseVersion} (stable).`);

// 1. Verify before anything irreversible.
run("npm", ["run", "typecheck"], root);
run("npm", ["test", "--", "--run"], root);

// 2. Sync the tray version so the DMG carries the same version as npm and the
//    extension. Stamp Cargo.lock too so the next `cargo build` (inside
//    package-dmg.sh) does not leave the lockfile dirty.
const cargoTomlPath = join(trayDir, "Cargo.toml");
const cargoLockPath = join(trayDir, "Cargo.lock");
writeFileSync(
	cargoTomlPath,
	stampPackageVersion(readFileSync(cargoTomlPath, "utf8"), releaseVersion),
);
writeFileSync(
	cargoLockPath,
	stampLockVersion(
		readFileSync(cargoLockPath, "utf8"),
		"sidecar-tray",
		releaseVersion,
	),
);
console.log(
	`\nStamped sidecar-tray Cargo.toml + Cargo.lock → ${releaseVersion}`,
);

// 3. Build artifacts BEFORE the irreversible registry steps. npm versions and
//    dist-tags cannot be rolled back safely, so a failed extension/DMG build
//    must abort here — never after `@latest` has already moved (cubic #109 P1).
// 3a. Extension zip (manifest stamped from package.json).
run("npm", ["run", "pack:extension"], root);
// 3b. Tray DMG (reads the now-synced version from Cargo.toml).
run("bash", [join(trayDir, "scripts", "package-dmg.sh")], root);

// 4. Publish npm and move `latest` — LAST, once both artifacts exist.
//    Idempotent: a retry after a partial failure (or a version already cut as
//    beta) skips the duplicate publish but STILL moves `latest`.
const alreadyPublished = () => {
	const { name } = pkg(root);
	try {
		execFileSync(
			"npm",
			["view", `${name}@${releaseVersion}`, "version", "--loglevel=error"],
			{ cwd: root, stdio: "pipe" },
		);
		return true;
	} catch (err) {
		// Only npm's version-specific "No match found for version X" 404 means the
		// requested version is genuinely unpublished, so publishing is safe. Any
		// other error (wrong name/registry/auth) is INCONCLUSIVE and must abort
		// rather than republish over an existing version (issue #26).
		const stderr = String(err?.stderr ?? "");
		if (isVersionNotFound(stderr, releaseVersion)) {
			return false;
		}
		throw new Error(
			`Inconclusive registry lookup for ${name}@${releaseVersion} — aborting ` +
				`to avoid a duplicate/broken publish:\n${stderr || err?.message || err}`,
		);
	}
};

const { name } = pkg(root);
if (alreadyPublished()) {
	console.log(
		`\nSkipping publish: ${name}@${releaseVersion} already on the registry.`,
	);
} else {
	// No `--tag` → npm publishes to the default `latest` dist-tag.
	run("npm", ["publish", ...otpFlags], root);
}
// Explicitly move `latest` so a promoted beta (or a re-run) points consumers
// of `@latest` at this version. Idempotent when already latest.
run(
	"npm",
	["dist-tag", "add", `${name}@${releaseVersion}`, "latest", ...otpFlags],
	root,
);

console.log("\n----------------------------------------");
console.log(`Stable release complete: bugtoprompt ${releaseVersion}`);
console.log("  npm:        published + latest moved");
console.log(`  extension:  bugtoprompt-extension-${releaseVersion}.zip`);
console.log("  tray:       sidecar-tray/dist/BugToPrompt.dmg");
console.log("----------------------------------------");
console.log("Next: commit the version bump (package.json + Cargo.toml/lock).");
