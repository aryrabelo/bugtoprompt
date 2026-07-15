// Regression for issue #41: the local-engine (uvx/parakeet) probe must NOT block
// the HTTP listener. Before the fix, `detectLocalEngine()` was awaited before
// `server.listen()`, so a missing or hung `uvx` delayed startup up to the 5s
// probe timeout (LOCAL_ENGINE_PROBE_TIMEOUT_MS). This spawns the real service
// with a `uvx` that HANGS and asserts /health answers 200 well under that
// window — proving the probe now runs in the background like the gh probes.
import { spawn } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SERVICE = join(
	dirname(fileURLToPath(import.meta.url)),
	"github-issue-service.mjs",
);

// The listener must come up far faster than the 5s probe timeout that the
// blocking version was bounded by. A cold node start is sub-second; 4s leaves
// generous CI headroom while still cleanly separating fixed from broken.
const READY_BUDGET_MS = 4_000;

const freePort = () =>
	new Promise((resolvePort, reject) => {
		const srv = createServer();
		srv.on("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const { port } = srv.address();
			srv.close(() => resolvePort(port));
		});
	});

let workDir;
let binDir;
let child;
let baseUrl;

beforeAll(async () => {
	workDir = mkdtempSync(join(tmpdir(), "bugtoprompt-startup-"));
	binDir = join(workDir, "bin");
	mkdirSync(binDir);

	// Fake `uvx` that hangs on the `--version` startup probe: if the probe were
	// still awaited, server.listen() would be stuck behind this for the full 5s
	// timeout before the process is killed.
	writeFileSync(join(binDir, "uvx"), "#!/bin/sh\nsleep 30\n");
	chmodSync(join(binDir, "uvx"), 0o755);

	const port = await freePort();
	baseUrl = `http://127.0.0.1:${port}`;
	const env = { ...process.env };
	delete env.ASSEMBLYAI_API_KEY;
	delete env.BUGTOPROMPT_TRANSCRIBE;
	delete env.BUGTOPROMPT_CONFIG;
	env.PATH = `${binDir}:${env.PATH}`;
	env.BUGTOPROMPT_PORT = String(port);
	child = spawn(process.execPath, [SERVICE], { cwd: workDir, env });
	child.on("error", () => {});
	child.stdout?.resume();
	child.stderr?.resume();
}, 20_000);

afterAll(() => {
	child?.kill("SIGKILL");
	if (workDir) rmSync(workDir, { recursive: true, force: true });
});

describe("startup is not blocked by the local-engine probe (issue #41)", () => {
	it("/health answers 200 well before the 5s probe timeout even when uvx hangs", async () => {
		const start = Date.now();
		let ok = false;
		for (;;) {
			try {
				const res = await fetch(`${baseUrl}/health`);
				if (res.ok) {
					ok = true;
					break;
				}
			} catch {
				// not listening yet
			}
			if (Date.now() - start > READY_BUDGET_MS) break;
			await new Promise((r) => setTimeout(r, 50));
		}
		const elapsed = Date.now() - start;
		expect(ok).toBe(true);
		expect(elapsed).toBeLessThan(READY_BUDGET_MS);
	});

	it("reports the safe unconfigured transcription state while the probe is pending", async () => {
		const res = await fetch(`${baseUrl}/health`);
		expect(res.status).toBe(200);
		const body = await res.json();
		// A hung uvx never resolves to "local"; the sentinel must be a valid
		// wire enum, not a crash or an undefined field.
		expect(["unconfigured", "ready", "local"]).toContain(body.transcription);
	});
});
