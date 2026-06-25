import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StreamingTranscriber } from "./StreamingTranscriber";

// ---------------------------------------------------------------------------
// Fake WebSocket: records the constructed URL, exposes onopen so the test can
// drive the connection, and captures sent audio (ArrayBuffer) frames so the
// 50–1000 ms aggregation window can be asserted. `last` exposes the most
// recent instance without reaching into the transcriber's privates.
// ---------------------------------------------------------------------------

class FakeWebSocket {
	static OPEN = 1;
	static lastUrl = "";
	static last: FakeWebSocket | undefined;
	readyState = FakeWebSocket.OPEN;
	binaryType = "";
	sentAudio: ArrayBuffer[] = [];
	sentText: string[] = [];
	onopen: (() => void) | null = null;
	onerror: ((e: unknown) => void) | null = null;
	onclose: ((e: { code?: number; reason?: string }) => void) | null = null;
	onmessage: ((ev: MessageEvent) => void) | null = null;

	constructor(url: string) {
		FakeWebSocket.lastUrl = url;
		FakeWebSocket.last = this;
	}

	send(data: unknown): void {
		if (data instanceof ArrayBuffer) this.sentAudio.push(data);
		else if (typeof data === "string") this.sentText.push(data);
	}
	close(): void {
		this.readyState = 3; // CLOSED
	}
}

async function connected(): Promise<{
	t: StreamingTranscriber;
	ws: FakeWebSocket;
}> {
	const t = new StreamingTranscriber();
	const started = t.start("tok", 16000);
	const ws = FakeWebSocket.last;
	if (!ws) throw new Error("FakeWebSocket was not constructed");
	ws.onopen?.();
	await started;
	return { t, ws };
}

beforeEach(() => {
	FakeWebSocket.lastUrl = "";
	FakeWebSocket.last = undefined;
	vi.stubGlobal("WebSocket", FakeWebSocket);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("StreamingTranscriber", () => {
	it("builds the v3 URL with the u3-rt-pro model, sample_rate, and token", async () => {
		const transcriber = new StreamingTranscriber();
		const started = transcriber.start("abc 123", 16000);

		FakeWebSocket.last?.onopen?.();
		await started;

		expect(FakeWebSocket.lastUrl).toContain("speech_model=u3-rt-pro");
		expect(FakeWebSocket.lastUrl).toContain("sample_rate=16000");
		expect(FakeWebSocket.lastUrl).toContain("token=");
		expect(FakeWebSocket.lastUrl).toContain("token=abc%20123");
	});

	// Regression for AssemblyAI error 3007 ("Input Duration Violation"): the
	// AudioWorklet tap emits ~2.7 ms (86-byte) PCM16 quanta; sending each one
	// verbatim is far below the API's 50 ms floor and closes the socket.
	const QUANTUM = (): ArrayBuffer => new ArrayBuffer(86); // ~2.69 ms @ 16 kHz

	it("buffers sub-window frames and does NOT send until ~100 ms accrues", async () => {
		const { t, ws } = await connected();
		// 18 quanta ≈ 48 ms — under the 100 ms send window.
		for (let i = 0; i < 18; i++) t.sendFrame(QUANTUM());
		expect(ws.sentAudio.length).toBe(0);
	});

	it("flushes one batch inside the 50–1000 ms window once it fills", async () => {
		const { t, ws } = await connected();
		// 40 quanta ≈ 107 ms — crosses the 100 ms window exactly once.
		for (let i = 0; i < 40; i++) t.sendFrame(QUANTUM());
		expect(ws.sentAudio.length).toBe(1);
		const bytes = ws.sentAudio[0].byteLength;
		// 16 kHz PCM16: 50 ms = 1600 B, 1000 ms = 32000 B.
		expect(bytes).toBeGreaterThanOrEqual(1600);
		expect(bytes).toBeLessThanOrEqual(32000);
	});

	it("flushes a trailing batch on stop when it clears the 50 ms floor", async () => {
		const { t, ws } = await connected();
		// 23 quanta ≈ 62 ms — below the send window but above the 50 ms floor.
		for (let i = 0; i < 23; i++) t.sendFrame(QUANTUM());
		expect(ws.sentAudio.length).toBe(0);
		t.stop();
		expect(ws.sentAudio.length).toBe(1);
		expect(ws.sentAudio[0].byteLength).toBeGreaterThanOrEqual(1600);
	});

	it("drops a sub-50 ms tail on stop instead of sending an illegal frame", async () => {
		const { t, ws } = await connected();
		// 5 quanta ≈ 13 ms — below the 50 ms floor; must NOT be sent.
		for (let i = 0; i < 5; i++) t.sendFrame(QUANTUM());
		t.stop();
		expect(ws.sentAudio.length).toBe(0);
		// Terminate control message is still sent (as text), not audio.
		expect(ws.sentText.some((m) => m.includes("Terminate"))).toBe(true);
	});
});
