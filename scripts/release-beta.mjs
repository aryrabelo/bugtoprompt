/**
 * One-shot beta release: verify → publish root + server (synchronized
 * versions) → rebuild the extension zip.
 *
 * Usage:
 *   npm run release:beta                          # publish both, no OTP
 *   npm run release:beta -- --otp=123456          # when npm enforces OTP (EOTP)
 *   npm run release:beta -- --bump                # first bump beta.N → beta.N+1
 *
 * Both packages are published in one run so their versions never diverge
 * (the plan's synchronized-version contract).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const server = join(root, "server");

const args = process.argv.slice(2);
// --otp is optional: only needed when the npm session enforces OTP on publish
// (EOTP error). Pass it through when provided.
const otpArg = args.find((a) => a.startsWith("--otp="));
const publishArgs = ["publish", "--tag", "beta", ...(otpArg ? [otpArg] : [])];
const bump = args.includes("--bump");

const run = (cmd, cmdArgs, cwd) => {
	console.log(`\n$ ${cmd} ${cmdArgs.join(" ")}  (${cwd})`);
	execFileSync(cmd, cmdArgs, { cwd, stdio: "inherit" });
};

const version = (dir) =>
	JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version;

// 1. Optional synchronized bump (0.14.0-beta.N → beta.N+1).
if (bump) {
	const current = version(root);
	const m = current.match(/^(.*-beta\.)(\d+)$/);
	if (!m) {
		console.error(`Cannot bump non-beta version "${current}".`);
		process.exit(1);
	}
	const next = `${m[1]}${Number(m[2]) + 1}`;
	run("npm", ["pkg", "set", `version=${next}`], root);
	run("npm", ["pkg", "set", `version=${next}`], server);
	console.log(`\nBumped both packages: ${current} → ${next}`);
}

if (version(root) !== version(server)) {
	console.error(
		`Version mismatch: root ${version(root)} vs server ${version(server)}. ` +
			"Both packages must publish the same version.",
	);
	process.exit(1);
}

// 2. Verify before anything irreversible.
run("npm", ["run", "typecheck"], root);
run("npm", ["test", "--", "--run"], root);

// 3. Publish both (root build runs via prepublish/prepack hooks as usual).
// Idempotent per package: a retry after a partial failure skips versions the
// registry already has instead of dying on E403 "cannot publish over".
const alreadyPublished = (dir) => {
	const { name } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
	try {
		execFileSync("npm", ["view", `${name}@${version(dir)}`, "version"], {
			cwd: dir,
			stdio: "pipe",
		});
		return true;
	} catch {
		return false;
	}
};
for (const dir of [root, server]) {
	if (alreadyPublished(dir)) {
		console.log(
			`\nSkipping ${dir === root ? "root" : "server"}: ${version(dir)} already on the registry.`,
		);
		continue;
	}
	run("npm", publishArgs, dir);
}

// 4. Rebuild the extension against the released version (manifest stamped
//    from package.json) and produce the distributable zip.
run("npm", ["run", "pack:extension"], root);

console.log(`\nReleased bugtoprompt + bugtoprompt-server ${version(root)}.`);
console.log("Next: repin GerarPosts and reload the unpacked extension.");
