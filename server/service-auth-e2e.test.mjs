// HTTP-level proof of the shared-secret wiring (issue #43): the constant-time
// compare in `presentsValidToken` is unit-tested in service-security.test.mjs,
// but nothing exercised the REAL request path — if the guard at the top of the
// request handler were bypassed or `presentsValidToken` regressed, the suite
// would still pass. Here the sidecar is spawned as a real child process with
// BUGTOPROMPT_TOKEN set and every contract is asserted over actual HTTP:
//
//   1. No token / wrong token / short & long tokens → 401 on guarded routes.
//   2. The correct token → 200, via both "Authorization: Bearer <token>" and
//      the "x-bugtoprompt-token" header.
//   3. GET /health stays reachable without the token but returns ONLY the
//      minimal `{ ok: true }` liveness body; the full health payload needs
//      the token.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SERVICE = join(
	dirname(fileURLToPath(import.meta.url)),
	"github-issue-service.mjs",
);
const TOKEN = "s3cret-e2e-token";

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
let child;
let baseUrl;

beforeAll(async () => {
	workDir = mkdtempSync(join(tmpdir(), "bugtoprompt-auth-e2e-"));
	const port = await freePort();
	baseUrl = `http://127.0.0.1:${port}`;
	const env = { ...process.env };
	delete env.ASSEMBLYAI_API_KEY;
	delete env.BUGTOPROMPT_TRANSCRIBE;
	delete env.BUGTOPROMPT_CONFIG;
	env.BUGTOPROMPT_PORT = String(port);
	env.BUGTOPROMPT_TOKEN = TOKEN;
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

	// Wait for readiness by polling /health (open even when a token is set).
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

const config = (headers = {}) =>
	fetch(`${baseUrl}/bugtoprompt/config`, { headers });

describe("shared-secret auth wiring (BUGTOPROMPT_TOKEN set, e2e)", () => {
	it("rejects a request with no token at all", async () => {
		const res = await config();
		expect(res.status).toBe(401);
		expect((await res.json()).error).toBe("unauthorized");
	});

	it("rejects a wrong same-length token", async () => {
		const res = await config({
			Authorization: `Bearer ${"x".repeat(TOKEN.length)}`,
		});
		expect(res.status).toBe(401);
	});

	it("rejects a shorter token that is a prefix of the real one", async () => {
		const res = await config({
			Authorization: `Bearer ${TOKEN.slice(0, -1)}`,
		});
		expect(res.status).toBe(401);
	});

	it("rejects a longer token that starts with the real one", async () => {
		const res = await config({
			Authorization: `Bearer ${TOKEN}x`,
		});
		expect(res.status).toBe(401);
	});

	it("accepts the correct token via Authorization: Bearer", async () => {
		const res = await config({ Authorization: `Bearer ${TOKEN}` });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toHaveProperty("transcriptionProvider");
	});

	it("accepts the correct token via the x-bugtoprompt-token header", async () => {
		const res = await config({ "x-bugtoprompt-token": TOKEN });
		expect(res.status).toBe(200);
	});

	it("guards POST routes too: /transcribe without token → 401", async () => {
		const res = await fetch(`${baseUrl}/transcribe`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ sessionId: "nope" }),
		});
		expect(res.status).toBe(401);
	});

	it("GET /health without token answers only the minimal liveness body", async () => {
		const res = await fetch(`${baseUrl}/health`);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
	});

	it("GET /health with the token returns the full health payload", async () => {
		const res = await fetch(`${baseUrl}/health`, {
			headers: { Authorization: `Bearer ${TOKEN}` },
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toHaveProperty("transcription");
	});
});
