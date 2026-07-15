// @vitest-environment node
// E4-T1 contract: the root package's `bugtoprompt` bin boots the sidecar and
// serves the /health contract. Spawns the bin as a real child process on an
// isolated port (never the default 4127) so nothing leaks into the suite.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const BIN = fileURLToPath(new URL("../bin/bugtoprompt.mjs", import.meta.url));
const PORT = 41270 + (process.pid % 100);

let child;

async function waitForHealth(port, timeoutMs = 10_000) {
	const deadline = Date.now() + timeoutMs;
	let lastError;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`http://127.0.0.1:${port}/health`);
			if (res.ok) return res;
			lastError = new Error(`status ${res.status}`);
		} catch (error) {
			lastError = error;
		}
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error(`sidecar never became healthy: ${lastError}`);
}

afterAll(async () => {
	if (child && child.exitCode === null) {
		child.kill("SIGTERM");
		await once(child, "exit");
	}
});

describe("bugtoprompt bin entrypoint", () => {
	it("starts the sidecar and answers GET /health with the contract shape", async () => {
		child = spawn(process.execPath, [BIN], {
			env: {
				...process.env,
				BUGTOPROMPT_PORT: String(PORT),
				BUGTOPROMPT_HOST: "127.0.0.1",
			},
			stdio: ["ignore", "pipe", "pipe"],
		});

		const res = await waitForHealth(PORT);
		const body = await res.json();
		expect(body.ok).toBe(true);
		expect(typeof body.issues).toBe("boolean");
		expect(typeof body.repos).toBe("number");
		expect(["ready", "unauthenticated", "missing"]).toContain(body.gh);
		expect(["ready", "local", "unconfigured"]).toContain(body.transcription);
	}, 15_000);
});
