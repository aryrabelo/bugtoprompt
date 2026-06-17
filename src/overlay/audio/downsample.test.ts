import { describe, expect, it } from "vitest";
import { createPcmDownsampler } from "./downsample";

describe("createPcmDownsampler", () => {
	it("passes through 1:1 when input rate equals target rate", () => {
		const down = createPcmDownsampler(16000, 16000);
		const frame = down(Float32Array.of(0, 0.5, -0.5, 1, -1));
		expect(frame).not.toBeNull();
		expect(frame?.length).toBe(5);
	});

	it("clamps out-of-range samples to the PCM16 extremes", () => {
		const down = createPcmDownsampler(16000, 16000);
		const frame = down(Float32Array.of(2, -2, 1, -1));
		// +full-scale uses 0x7fff, -full-scale uses 0x8000 (= -32768).
		expect(Array.from(frame ?? [])).toEqual([32767, -32768, 32767, -32768]);
	});

	it("decimates by the integer ratio (48k -> 16k keeps every 3rd sample)", () => {
		const down = createPcmDownsampler(48000, 16000);
		// 9 input samples at step 3 -> indices 0,3,6 -> 3 output samples.
		const input = Float32Array.from({ length: 9 }, (_v, i) => (i % 2 ? 1 : 0));
		const frame = down(input);
		expect(frame?.length).toBe(3);
		// indices 0,3,6 -> values 0,1,0 -> 0, 32767, 0
		expect(Array.from(frame ?? [])).toEqual([0, 32767, 0]);
	});

	it("carries the fractional read position across blocks (non-integer ratio)", () => {
		// 44.1k -> 16k => step ≈ 2.756; a stateful resampler must not reset per
		// block. Across several blocks it should stay within one sample of the
		// one-shot total and of the ideal 16 kHz output count.
		const blockLen = 441; // 10 ms at 44.1 kHz
		const blocks = 3;
		const streamed = createPcmDownsampler(44100, 16000);
		let streamedTotal = 0;
		for (let i = 0; i < blocks; i++) {
			streamedTotal += streamed(new Float32Array(blockLen))?.length ?? 0;
		}
		const whole = createPcmDownsampler(44100, 16000);
		const wholeTotal = whole(new Float32Array(blockLen * blocks))?.length ?? 0;
		expect(Math.abs(streamedTotal - wholeTotal)).toBeLessThanOrEqual(1);
		// And it stays near the ideal 16 kHz sample count for 30 ms of audio.
		expect(Math.abs(streamedTotal - 480)).toBeLessThanOrEqual(1);
	});

	it("returns null for an empty block", () => {
		const down = createPcmDownsampler(48000, 16000);
		expect(down(new Float32Array(0))).toBeNull();
	});

	it("emits an Int16Array whose buffer can be transferred to the ws", () => {
		const down = createPcmDownsampler(16000, 16000);
		const frame = down(Float32Array.of(0.25));
		expect(frame).toBeInstanceOf(Int16Array);
		expect(frame?.buffer).toBeInstanceOf(ArrayBuffer);
	});
});
