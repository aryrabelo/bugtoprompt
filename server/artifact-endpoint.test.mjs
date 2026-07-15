// @vitest-environment node
// Endpoint regression for the duplicate-screenshotRef guard: two non-empty
// screenshots sharing a valid ref must 400 BEFORE any capture files are
// created or overwritten. Boots the real sidecar as a child process in an
// isolated tmp cwd (CAPTURES_ROOT is cwd-relative) on an isolated port.
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const SERVICE = fileURLToPath(
	new URL("./github-issue-service.mjs", import.meta.url),
);
const PORT = 41470 + (process.pid % 100);
const WORK = mkdtempSync(join(tmpdir(), "btp-artifact-test-"));

let child;

async function waitForHealth(port, timeoutMs = 10_000) {
	const deadline = Date.now() + timeoutMs;
	let lastError;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`http://127.0.0.1:${port}/health`);
			if (res.ok) return;
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
	rmSync(WORK, { recursive: true, force: true });
});

describe("POST /artifact duplicate screenshotRef guard", () => {
	it("returns 400 and touches no files when two screenshots reuse one ref", async () => {
		child = spawn(process.execPath, [SERVICE], {
			cwd: WORK,
			env: {
				...process.env,
				BUGTOPROMPT_PORT: String(PORT),
				BUGTOPROMPT_HOST: "127.0.0.1",
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		await waitForHealth(PORT);

		// Pre-existing capture for the same sessionId must survive the rejection.
		const sessionId = "cap_dup-ref-session";
		const dir = join(WORK, ".bugtoprompt", "captures", sessionId);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "artifact.json"), '{"prior":true}');

		const png = Buffer.from("fake-image").toString("base64");
		const res = await fetch(`http://127.0.0.1:${PORT}/artifact`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				artifact: {
					sessionId,
					snapshots: [
						{ screenshotRef: "snap-0001.jpg" },
						{ screenshotRef: "snap-0001.jpg" },
					],
				},
				screenshotsBase64: [png, png],
			}),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toMatch(/reuses screenshotRef snap-0001\.jpg/);

		// Nothing was written or clobbered: prior artifact intact, no JPEG.
		expect(readFileSync(join(dir, "artifact.json"), "utf8")).toBe(
			'{"prior":true}',
		);
		expect(existsSync(join(dir, "snap-0001.jpg"))).toBe(false);
	}, 15_000);

	it("accepts distinct valid refs for the same payload shape", async () => {
		const png = Buffer.from("fake-image").toString("base64");
		const res = await fetch(`http://127.0.0.1:${PORT}/artifact`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				artifact: {
					sessionId: "cap_distinct-ref-session",
					snapshots: [
						{ screenshotRef: "snap-0001.jpg" },
						{ screenshotRef: "snap-0002.jpg" },
					],
				},
				screenshotsBase64: [png, png],
			}),
		});
		expect(res.status).toBe(200);
		const dir = join(
			WORK,
			".bugtoprompt",
			"captures",
			"cap_distinct-ref-session",
		);
		expect(existsSync(join(dir, "snap-0001.jpg"))).toBe(true);
		expect(existsSync(join(dir, "snap-0002.jpg"))).toBe(true);
	}, 15_000);
});
