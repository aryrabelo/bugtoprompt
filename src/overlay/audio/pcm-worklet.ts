/**
 * The PCM downsampling AudioWorklet. `AudioContext.sampleRate` is the hardware
 * rate (≈48 kHz in WKWebView), not 16 kHz — AssemblyAI universal-streaming wants
 * 16 kHz mono PCM16, so this processor decimates native → 16 kHz and posts
 * Int16 frames to the main thread. Shipped as a source string + Blob URL so no
 * bundler worklet handling is needed (works identically in Vite dev + the Tauri
 * bundle). The fractional read position carries across process() blocks.
 */

export const PCM_WORKLET_NAME = "pcm-worklet";

const PCM_WORKLET_SOURCE = `
class PCMWorklet extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const target = (options.processorOptions && options.processorOptions.targetRate) || 16000;
    // sampleRate is a global in the AudioWorkletGlobalScope (the hardware rate).
    this.step = sampleRate / target;
    this.pos = 0;
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel || channel.length === 0) return true;
    const out = [];
    while (this.pos < channel.length) {
      let s = channel[Math.floor(this.pos)] || 0;
      if (s < -1) s = -1; else if (s > 1) s = 1;
      out.push(s < 0 ? s * 0x8000 : s * 0x7fff);
      this.pos += this.step;
    }
    // carry the fractional remainder into the next block
    this.pos -= channel.length;
    if (out.length > 0) {
      const frame = new Int16Array(out);
      this.port.postMessage(frame.buffer, [frame.buffer]);
    }
    return true;
  }
}
registerProcessor(${JSON.stringify(PCM_WORKLET_NAME)}, PCMWorklet);
`;

/** A Blob URL for the worklet module — pass to `audioWorklet.addModule`. The
 *  caller should `URL.revokeObjectURL` it after registration. */
export function pcmWorkletUrl(): string {
	return URL.createObjectURL(
		new Blob([PCM_WORKLET_SOURCE], { type: "application/javascript" }),
	);
}
