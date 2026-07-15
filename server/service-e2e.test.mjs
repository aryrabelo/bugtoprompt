// End-to-end proof of the LITE invariants (issue #5): the sidecar is spawned
// as a REAL child process with no ASSEMBLYAI_API_KEY, and the local parakeet
// path is exercised through fake `uvx`/`ffmpeg` executables prepended to PATH
// (localTranscribe shells out to those binaries — see local-transcribe.mjs).
//
//   1. POST /transcribe  → 200 via the LOCAL default path; artifact.json is
//      re-persisted with transcriptionMode "batch-fallback".
//   2. POST /streaming-token → 501 with a clear error (streaming is the
//      optional AssemblyAI opt-in, never required).
//   3. GET /health → transcription "local".
//   4. GET /bugtoprompt/config → transcriptionProvider "local" (issue #13).
import { spawn } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SERVICE = join(
	dirname(fileURLToPath(import.meta.url)),
	"github-issue-service.mjs",
);
const SESSION_ID = "cap_e2e-local-1";

/** Parakeet output in the real CLI shape: sentences[].tokens with seconds. */
const PARAKEET_JSON = JSON.stringify({
	text: "Hello world.",
	sentences: [
		{
			tokens: [
				{ text: " Hello", start: 0.0, end: 0.5 },
				{ text: " world.", start: 0.6, end: 1.2 },
			],
		},
	],
});

const freePort = () =>
	new Promise((resolvePort, reject) => {
		const srv = createServer();
		srv.once("error", reject);
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
	workDir = mkdtempSync(join(tmpdir(), "bugtoprompt-e2e-"));
	binDir = join(workDir, "bin");
	mkdirSync(binDir);

	// Fake `uvx`: succeeds on the `--version` startup probe, and on a real
	// transcription run writes audio.json into the --output-dir like the CLI.
	writeFileSync(
		join(binDir, "uvx"),
		`#!/bin/sh
dir=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--output-dir" ]; then dir="$a"; fi
  prev="$a"
done
if [ -z "$dir" ]; then exit 0; fi
cat > "$dir/audio.json" <<'JSON'
${PARAKEET_JSON}
JSON
`,
	);
	chmodSync(join(binDir, "uvx"), 0o755);
	// Fake `ffmpeg`: the wav it would produce is never read by the fake uvx.
	writeFileSync(join(binDir, "ffmpeg"), "#!/bin/sh\nexit 0\n");
	chmodSync(join(binDir, "ffmpeg"), 0o755);

	// A saved capture session the /transcribe handler can find under cwd.
	const sessionDir = join(workDir, ".bugtoprompt", "captures", SESSION_ID);
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(join(sessionDir, "audio.webm"), "fake-webm-bytes");
	writeFileSync(
		join(sessionDir, "artifact.json"),
		JSON.stringify({ sessionId: SESSION_ID }),
	);

	const port = await freePort();
	baseUrl = `http://127.0.0.1:${port}`;
	const env = { ...process.env };
	delete env.ASSEMBLYAI_API_KEY;
	delete env.BUGTOPROMPT_TRANSCRIBE;
	delete env.BUGTOPROMPT_CONFIG;
	env.PATH = `${binDir}:${env.PATH}`;
	env.BUGTOPROMPT_PORT = String(port);
	child = spawn(process.execPath, [SERVICE], { cwd: workDir, env });
	let spawnError = null;
	let stderrBuf = "";
	child.on("error", (err) => {
		spawnError = err;
	});
	child.stderr.on("data", (chunk) => {
		stderrBuf += String(chunk);
	});
	child.stdout.resume(); // drain so the child never blocks on a full pipe

	// Wait for readiness by polling /health.
	const deadline = Date.now() + 15_000;
	for (;;) {
		if (spawnError) throw new Error(`server failed to spawn: ${spawnError}`);
		try {
			const res = await fetch(`${baseUrl}/health`);
			if (res.ok) break;
		} catch {
			// not listening yet
		}
		if (Date.now() > deadline) {
			throw new Error(
				`server never became ready; stderr:\n${stderrBuf || "(empty)"}`,
			);
		}
		await new Promise((r) => setTimeout(r, 100));
	}
}, 20_000);

afterAll(() => {
	child?.kill("SIGKILL");
	if (workDir) rmSync(workDir, { recursive: true, force: true });
});

describe("sidecar LITE defaults (no ASSEMBLYAI_API_KEY, e2e)", () => {
	it("POST /transcribe uses the local parakeet path and persists batch-fallback", async () => {
		const res = await fetch(`${baseUrl}/transcribe`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ sessionId: SESSION_ID }),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.transcript).toEqual([
			{ tStartMs: 0, tEndMs: 1200, text: "Hello world." },
		]);

		const artifact = JSON.parse(
			await readFile(
				join(workDir, ".bugtoprompt", "captures", SESSION_ID, "artifact.json"),
				"utf8",
			),
		);
		expect(artifact.transcriptionMode).toBe("batch-fallback");
		expect(artifact.transcript).toEqual(body.transcript);
	});

	it("POST /streaming-token answers 501 with a clear error (optional opt-in)", async () => {
		const res = await fetch(`${baseUrl}/streaming-token`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(501);
		const body = await res.json();
		expect(body.error).toMatch(/streaming not available in local mode/);
	});

	it("GET /health reports the local transcription state", async () => {
		const res = await fetch(`${baseUrl}/health`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.transcription).toBe("local");
	});

	it("GET /bugtoprompt/config reports the active transcription provider", async () => {
		const res = await fetch(`${baseUrl}/bugtoprompt/config`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.transcriptionProvider).toBe("local");
	});
});
