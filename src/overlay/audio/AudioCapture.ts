/**
 * Microphone capture for a debug session. Two independent consumers of one mic
 * stream: a MediaRecorder that ALWAYS keeps the recording (the durable artifact,
 * so a websocket drop never loses audio), and a live PCM tap that streams 16 kHz
 * PCM16 frames for real-time transcription.
 *
 * The live tap is best-effort and prefers an AudioWorklet, but degrades through
 * a ScriptProcessor fallback when AudioWorklet is unavailable (older Safari /
 * WKWebView builds, or a worklet module that fails to load) so live captions
 * keep flowing wherever any Web Audio path can downsample. Only when neither
 * engine works does the session drop to batch transcription of the kept
 * recording. Recording is never affected by live-tap failures.
 */
import { createPcmDownsampler } from "./downsample";
import { PCM_WORKLET_NAME, pcmWorkletUrl } from "./pcm-worklet";

export interface AudioCaptureHandlers {
	/** Called with each 16 kHz PCM16 frame from the live tap (when available). */
	onPcmFrame?: (frame: ArrayBuffer) => void;
}

export interface StoppedAudio {
	blob: Blob;
	mimeType: string;
	bytes: number;
}

/** Which Web Audio engine is feeding live PCM frames (for diagnostics). */
export type LiveEngine = "worklet" | "scriptprocessor" | "none";

const PREFERRED_MIME = "audio/webm;codecs=opus";
/** ScriptProcessor block size: a power of two balancing latency vs. overhead. */
const SCRIPT_PROCESSOR_BUFFER = 4096;
const TARGET_RATE = 16000;
/** How long to wait for a getUserMedia permission before declaring it hung. */
const GET_USER_MEDIA_TIMEOUT_MS = 15000;

/** Reject with `message` if `promise` hasn't settled within `ms`. */
function withTimeout<T>(
	promise: Promise<T>,
	ms: number,
	message: string,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(message)), ms);
		promise.then(
			(v) => {
				clearTimeout(timer);
				resolve(v);
			},
			(err) => {
				clearTimeout(timer);
				reject(err);
			},
		);
	});
}

export class AudioCapture {
	private stream?: MediaStream;
	private recorder?: MediaRecorder;
	private chunks: Blob[] = [];
	private ctx?: AudioContext;
	private source?: MediaStreamAudioSourceNode;
	private node?: AudioWorkletNode;
	private scriptNode?: ScriptProcessorNode;
	private mimeType = PREFERRED_MIME;
	/** True when a live PCM tap is running (streaming transcription is possible). */
	streaming = false;
	/** The engine currently feeding PCM frames — surfaced for diagnostics. */
	liveEngine: LiveEngine = "none";

	async start(handlers: AudioCaptureHandlers = {}): Promise<void> {
		// Fail loudly when the host webview lacks the media APIs entirely (e.g. a
		// WKWebView without the microphone entitlement) instead of throwing an
		// opaque "undefined is not an object" further down.
		if (!navigator.mediaDevices?.getUserMedia) {
			throw new Error(
				"getUserMedia is unavailable in this webview. The host app must grant microphone access (on macOS/Tauri: add NSMicrophoneUsageDescription and the audio-input entitlement).",
			);
		}
		if (typeof MediaRecorder === "undefined") {
			throw new Error(
				"MediaRecorder is unavailable in this webview, so audio cannot be recorded.",
			);
		}

		// A missing OS permission can leave getUserMedia pending forever (no
		// prompt, no rejection). Race it against a timeout so a hung permission
		// surfaces as a real error the overlay can show, rather than a record
		// button that silently does nothing.
		this.stream = await withTimeout(
			navigator.mediaDevices.getUserMedia({
				audio: {
					channelCount: 1,
					echoCancellation: true,
					noiseSuppression: true,
				},
			}),
			GET_USER_MEDIA_TIMEOUT_MS,
			"Microphone access timed out. The host app likely lacks microphone permission (on macOS/Tauri: add NSMicrophoneUsageDescription and the audio-input entitlement).",
		);

		this.mimeType = MediaRecorder.isTypeSupported(PREFERRED_MIME)
			? PREFERRED_MIME
			: "audio/webm";
		this.recorder = new MediaRecorder(this.stream, { mimeType: this.mimeType });
		this.recorder.ondataavailable = (e) => {
			if (e.data.size > 0) this.chunks.push(e.data);
		};
		this.recorder.start(1000);

		if (handlers.onPcmFrame) {
			await this.startLive(handlers.onPcmFrame).catch((err) => {
				// No live engine available ⇒ no live captions; recording is unaffected.
				console.warn(
					"debug: live PCM tap unavailable (no Web Audio engine); batch fallback",
					err,
				);
				this.streaming = false;
				this.liveEngine = "none";
			});
		}
	}

	/**
	 * Start live PCM streaming on the ALREADY-RUNNING mic stream. Used when the
	 * user pastes an AssemblyAI key mid-recording: the recorder keeps going while
	 * the live tap attaches on top. Idempotent — returns true if streaming is (or
	 * becomes) live, false if no Web Audio engine could be brought up.
	 */
	async attachLiveTranscription(
		onPcmFrame: (frame: ArrayBuffer) => void,
	): Promise<boolean> {
		if (this.streaming) return true;
		try {
			await this.startLive(onPcmFrame);
		} catch (err) {
			console.warn(
				"debug: live PCM tap unavailable (no Web Audio engine); batch fallback",
				err,
			);
			this.streaming = false;
			this.liveEngine = "none";
		}
		return this.streaming;
	}

	/**
	 * Bring up a live PCM tap on the mic stream. Prefers an AudioWorklet; on any
	 * worklet failure (unsupported API or a module that won't load) it degrades
	 * to a ScriptProcessor-based downsampler so live captions survive on browsers
	 * without AudioWorklet. Throws only when NEITHER engine can start.
	 */
	private async startLive(
		onPcmFrame: (frame: ArrayBuffer) => void,
	): Promise<void> {
		if (!this.stream) return;
		const ctx = this.ctx ?? new AudioContext();
		this.ctx = ctx;
		const source = this.source ?? ctx.createMediaStreamSource(this.stream);
		this.source = source;

		try {
			await this.startWorklet(ctx, source, onPcmFrame);
			this.liveEngine = "worklet";
			this.streaming = true;
			console.info("debug: live transcription engine = AudioWorklet");
			return;
		} catch (err) {
			console.warn(
				"debug: AudioWorklet unavailable; trying ScriptProcessor fallback",
				err,
			);
		}

		// Fallback: ScriptProcessor decimation. Throws to the caller if even this
		// is missing (no Web Audio at all) so the session knows to go batch-only.
		this.startScriptProcessor(ctx, source, onPcmFrame);
		this.liveEngine = "scriptprocessor";
		this.streaming = true;
		console.info("debug: live transcription engine = ScriptProcessor fallback");
	}

	private async startWorklet(
		ctx: AudioContext,
		source: MediaStreamAudioSourceNode,
		onPcmFrame: (frame: ArrayBuffer) => void,
	): Promise<void> {
		if (!ctx.audioWorklet) throw new Error("AudioWorklet unsupported");
		const url = pcmWorkletUrl();
		try {
			await ctx.audioWorklet.addModule(url);
		} finally {
			URL.revokeObjectURL(url);
		}
		const node = new AudioWorkletNode(ctx, PCM_WORKLET_NAME, {
			processorOptions: { targetRate: TARGET_RATE },
		});
		node.port.onmessage = (e) => onPcmFrame(e.data as ArrayBuffer);
		// Route through a zero-gain sink so the engine keeps pulling the worklet
		// without any audible monitoring.
		const sink = ctx.createGain();
		sink.gain.value = 0;
		source.connect(node).connect(sink).connect(ctx.destination);
		this.node = node;
	}

	private startScriptProcessor(
		ctx: AudioContext,
		source: MediaStreamAudioSourceNode,
		onPcmFrame: (frame: ArrayBuffer) => void,
	): void {
		if (typeof ctx.createScriptProcessor !== "function") {
			throw new Error("ScriptProcessor unsupported");
		}
		const node = ctx.createScriptProcessor(SCRIPT_PROCESSOR_BUFFER, 1, 1);
		const downsample = createPcmDownsampler(ctx.sampleRate, TARGET_RATE);
		node.onaudioprocess = (e) => {
			const frame = downsample(e.inputBuffer.getChannelData(0));
			if (frame) onPcmFrame(frame.slice().buffer);
		};
		// Same zero-gain sink trick: a ScriptProcessor only fires onaudioprocess
		// while connected toward the destination.
		const sink = ctx.createGain();
		sink.gain.value = 0;
		source.connect(node);
		node.connect(sink).connect(ctx.destination);
		this.scriptNode = node;
	}

	/** Native audio sample rate (for the streaming ws); 0 before start. */
	sampleRate(): number {
		return this.ctx?.sampleRate ?? 0;
	}

	async stop(): Promise<StoppedAudio> {
		const blob = await this.stopRecorder();
		this.teardown();
		return { blob, mimeType: this.mimeType, bytes: blob.size };
	}

	private stopRecorder(): Promise<Blob> {
		const { promise, resolve } = Promise.withResolvers<Blob>();
		const recorder = this.recorder;
		if (!recorder || recorder.state === "inactive") {
			resolve(new Blob(this.chunks, { type: this.mimeType }));
			return promise;
		}
		recorder.onstop = () =>
			resolve(new Blob(this.chunks, { type: this.mimeType }));
		recorder.stop();
		return promise;
	}

	private teardown(): void {
		this.node?.port.close();
		this.node?.disconnect();
		if (this.scriptNode) this.scriptNode.onaudioprocess = null;
		this.scriptNode?.disconnect();
		this.source?.disconnect();
		void this.ctx?.close().catch(() => undefined);
		for (const track of this.stream?.getTracks() ?? []) track.stop();
		this.streaming = false;
		this.liveEngine = "none";
	}
}
