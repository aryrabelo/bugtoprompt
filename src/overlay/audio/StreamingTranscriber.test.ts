import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StreamingTranscriber } from "./StreamingTranscriber";

// ---------------------------------------------------------------------------
// Fake WebSocket: records the constructed URL and exposes onopen so the test
// can drive the connection to a resolved state.
// ---------------------------------------------------------------------------

class FakeWebSocket {
	static lastUrl = "";
	binaryType = "";
	onopen: (() => void) | null = null;
	onerror: ((e: unknown) => void) | null = null;
	onclose: (() => void) | null = null;
	onmessage: ((ev: MessageEvent) => void) | null = null;

	constructor(url: string) {
		FakeWebSocket.lastUrl = url;
	}

	send(): void {}
	close(): void {}
}

beforeEach(() => {
	FakeWebSocket.lastUrl = "";
	vi.stubGlobal("WebSocket", FakeWebSocket);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("StreamingTranscriber", () => {
	it("builds the v3 URL with the u3-rt-pro model, sample_rate, and token", async () => {
		const transcriber = new StreamingTranscriber();
		const started = transcriber.start("abc 123", 16000);

		// Drive the socket open so start() resolves.
		const ws = transcriber as unknown as { ws: FakeWebSocket };
		ws.ws.onopen?.();
		await started;

		expect(FakeWebSocket.lastUrl).toContain("speech_model=u3-rt-pro");
		expect(FakeWebSocket.lastUrl).toContain("sample_rate=16000");
		expect(FakeWebSocket.lastUrl).toContain("token=");
		// Token is URL-encoded.
		expect(FakeWebSocket.lastUrl).toContain("token=abc%20123");
	});
});
