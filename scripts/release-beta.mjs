/**
 * One-shot beta release: verify → publish the root package → rebuild the
 * extension zip.
 *
 * Usage:
 *   npm run release:beta                          # publish, no OTP
 *   npm run release:beta -- --otp=123456          # when npm enforces OTP (EOTP)
 *   npm run release:beta -- --bump                # first bump beta.N → beta.N+1
 *
 * Only the root `bugtoprompt` package is published. The standalone
 * `bugtoprompt-server` package was discontinued (its sidecar now ships inside
 * root), so it is no longer released here.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const args = process.argv.slice(2);
// --otp is optional: only needed when the npm session enforces OTP on publish
// (EOTP error). Pass it through when provided.
const otpArg = args.find((a) => a.startsWith("--otp="));
const publishArgs = ["publish", "--tag", "beta", ...(otpArg ? [otpArg] : [])];
const bump = args.includes("--bump");

// Redact OTP in the echoed command so captured logs never retain the code,
// while still passing the original arguments through to execFileSync.
const run = (cmd, cmdArgs, cwd) => {
	const shown = cmdArgs.map((a) =>
		a.startsWith("--otp=") ? "--otp=<redacted>" : a,
	);
	console.log(`\n$ ${cmd} ${shown.join(" ")}  (${cwd})`);
	execFileSync(cmd, cmdArgs, { cwd, stdio: "inherit" });
};

const version = (dir) =>
	JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version;

// 1. Optional beta bump (0.14.0-beta.N → beta.N+1).
if (bump) {
	const current = version(root);
	const m = current.match(/^(.*-beta\.)(\d+)$/);
	if (!m) {
		console.error(`Cannot bump non-beta version "${current}".`);
		process.exit(1);
	}
	const next = `${m[1]}${Number(m[2]) + 1}`;
	run("npm", ["pkg", "set", `version=${next}`], root);
	console.log(`\nBumped root package: ${current} → ${next}`);
}

// 2. Verify before anything irreversible.
run("npm", ["run", "typecheck"], root);
run("npm", ["test", "--", "--run"], root);

// 3. Publish the root package (build runs via prepublish/prepack hooks as
// usual). Idempotent: a retry after a partial failure skips a version the
// registry already has instead of dying on E403 "cannot publish over".
const alreadyPublished = (dir) => {
	const { name } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
	try {
		execFileSync(
			"npm",
			["view", `${name}@${version(dir)}`, "version", "--loglevel=error"],
			{
				cwd: dir,
				stdio: "pipe",
			},
		);
		return true;
	} catch (err) {
		const stderr = String(err?.stderr ?? err?.stdout ?? "");
		// A missing package/version is the only case that legitimately means
		// "not yet published". Transient/auth/registry errors must stay loud so
		// a partial release is never silently treated as complete.
		if (
			/E404|404 Not Found|is not in this registry|no such package/i.test(stderr)
		) {
			return false;
		}
		throw err;
	}
};
if (alreadyPublished(root)) {
	console.log(`\nSkipping root: ${version(root)} already on the registry.`);
} else {
	run("npm", publishArgs, root);
}

// 4. Rebuild the extension against the released version (manifest stamped
//    from package.json) and produce the distributable zip.
run("npm", ["run", "pack:extension"], root);

console.log(`\nReleased bugtoprompt ${version(root)}.`);
console.log("Next: repin GerarPosts and reload the unpacked extension.");
