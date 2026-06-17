/**
 * Decimating downsampler shared by the ScriptProcessor live-PCM fallback.
 *
 * Mirrors the {@link pcm-worklet} AudioWorklet processor exactly: nearest-sample
 * decimation from the native hardware rate down to the target rate, with a
 * fractional read position carried across blocks so the resampling stays
 * phase-continuous. Emits clamped PCM16. Kept pure (state lives in the returned
 * closure) so it is unit-testable without a Web Audio context — the worklet
 * runs the same math inline because it ships as a source string and cannot
 * import this module.
 */

/**
 * Build a stateful downsampler. Feed it successive mono Float32 blocks (as from
 * `ScriptProcessorNode.onaudioprocess`); each call returns the PCM16 frame for
 * that block, or `null` when the block produced no output sample.
 */
export function createPcmDownsampler(
	inputRate: number,
	targetRate = 16000,
): (channel: Float32Array) => Int16Array | null {
	const step = inputRate / targetRate;
	let pos = 0;
	return (channel) => {
		if (channel.length === 0) return null;
		const out: number[] = [];
		while (pos < channel.length) {
			let s = channel[Math.floor(pos)] || 0;
			if (s < -1) s = -1;
			else if (s > 1) s = 1;
			out.push(s < 0 ? s * 0x8000 : s * 0x7fff);
			pos += step;
		}
		// Carry the fractional remainder into the next block.
		pos -= channel.length;
		return out.length > 0 ? new Int16Array(out) : null;
	};
}
