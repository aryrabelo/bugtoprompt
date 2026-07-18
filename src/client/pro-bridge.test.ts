/**
 * jsdom roundtrip tests for the MAIN-world PRO bridge client (P0 fix, issue
 * #82). A fake relay stands in for the extension's content script + service
 * worker: it answers every `btp:pro-request` with a scripted
 * `btp:pro-response`, dispatched as a real `message` event so the client's
 * `window.addEventListener("message", ...)` handling is exercised for real.
 *
 * The outbound leg is intercepted via a `window.postMessage` spy rather than
 * relying on jsdom to self-deliver the post — jsdom does not implement the
 * `targetOrigin: "/"` case the client uses (real browsers treat "/" as "use
 * the document's own origin"; jsdom silently drops it), so a real
 * `postMessage(msg, "/")` never reaches this same window in tests. The spy
 * still asserts the client posted exactly the contract-shaped request.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Target } from "./index";
import { createProBridgeClient } from "./pro-bridge";

interface ProRequestMessage {
	type: "btp:pro-request";
	id: string;
	op: string;
	payload: unknown;
}

function isProRequest(data: unknown): data is ProRequestMessage {
	return (
		typeof data === "object" &&
		data !== null &&
		"type" in data &&
		data.type === "btp:pro-request"
	);
}

/** Install a fake relay answering every request via `respond`, dispatched as
 *  a real `message` event (source: window) — the same shape the extension's
 *  relay content script produces. Captures each request for assertions. */
function installRelay(
	respond: (
		op: string,
		payload: unknown,
	) => { ok: true; result: unknown } | { ok: false; error: string },
	onRequest?: (msg: ProRequestMessage) => void,
): void {
	vi.spyOn(window, "postMessage").mockImplementation((message: unknown) => {
		if (!isProRequest(message)) return;
		onRequest?.(message);
		const outcome = respond(message.op, message.payload);
		window.dispatchEvent(
			new MessageEvent("message", {
				data: { type: "btp:pro-response", id: message.id, ...outcome },
				source: window,
			}),
		);
	});
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("createProBridgeClient (P0 fix, issue #82)", () => {
	it('mintStreamingToken posts op "mintStreamingToken" and resolves with the relayed result', async () => {
		let capturedOp: string | undefined;
		let capturedPayload: unknown;
		installRelay(
			() => ({ ok: true, result: { token: "tok", expiresAt: 999 } }),
			(msg) => {
				capturedOp = msg.op;
				capturedPayload = msg.payload;
			},
		);

		const result = await createProBridgeClient().mintStreamingToken("t1");

		expect(capturedOp).toBe("mintStreamingToken");
		expect(capturedPayload).toEqual({ targetId: "t1" });
		expect(result).toEqual({ token: "tok", expiresAt: 999 });
	});

	it("rejects when the relay responds ok:false, with the relayed error message", async () => {
		installRelay(() => ({ ok: false, error: "no PRO subscription" }));

		await expect(createProBridgeClient().listTargets("p1")).rejects.toThrow(
			"no PRO subscription",
		);
	});

	it("saveArtifact/transcribeBatch/createIssue/listTargets post the exact contract op + payload", async () => {
		const seen: { op: string; payload: unknown }[] = [];
		installRelay(
			() => ({ ok: true, result: {} }),
			(msg) => seen.push({ op: msg.op, payload: msg.payload }),
		);
		const client = createProBridgeClient();

		await client.saveArtifact({
			artifact: { sessionId: "s1" } as never,
			audioBase64: "aa",
			screenshotsBase64: ["bb"],
		});
		await client.transcribeBatch("s1", "t1");
		await client.createIssue({ sessionId: "s1", prompt: "p" });
		await client.listTargets("proj-1");

		expect(seen).toEqual([
			{
				op: "saveArtifact",
				payload: {
					artifact: { sessionId: "s1" },
					audioBase64: "aa",
					screenshotsBase64: ["bb"],
				},
			},
			{ op: "transcribeBatch", payload: { sessionId: "s1", targetId: "t1" } },
			{ op: "createIssue", payload: { sessionId: "s1", prompt: "p" } },
			{ op: "listTargets", payload: { projectId: "proj-1" } },
		]);
	});

	it("listTargets resolves the relayed result as Target[]", async () => {
		const targets: Target[] = [{ id: "t1", name: "main", branch: "main" }];
		installRelay(() => ({ ok: true, result: targets }));

		await expect(createProBridgeClient().listTargets("p1")).resolves.toEqual(
			targets,
		);
	});

	it("matches concurrent requests to their own response by id (no cross-talk)", async () => {
		installRelay((_op, payload) => {
			const targetId = (payload as { targetId?: string }).targetId;
			return { ok: true, result: { token: `tok-${targetId}`, expiresAt: 0 } };
		});
		const client = createProBridgeClient();

		const [a, b] = await Promise.all([
			client.mintStreamingToken("a"),
			client.mintStreamingToken("b"),
		]);

		expect(a).toEqual({ token: "tok-a", expiresAt: 0 });
		expect(b).toEqual({ token: "tok-b", expiresAt: 0 });
	});

	it("removes its message listener once the request settles — no leaked/duplicate handling", async () => {
		installRelay(() => ({ ok: true, result: { token: "tok", expiresAt: 0 } }));
		const addSpy = vi.spyOn(window, "addEventListener");
		const removeSpy = vi.spyOn(window, "removeEventListener");

		await createProBridgeClient().mintStreamingToken();

		const adds = addSpy.mock.calls.filter(
			([type]) => type === "message",
		).length;
		const removes = removeSpy.mock.calls.filter(
			([type]) => type === "message",
		).length;
		expect(adds).toBe(1);
		expect(removes).toBe(1);
	});
});
