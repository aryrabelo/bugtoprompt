/**
 * Microphone capture for a debug session. Two independent consumers of one mic
 * stream: a MediaRecorder that ALWAYS keeps the recording (the durable artifact,
 * so a websocket drop never loses audio), and an AudioWorklet that streams 16 kHz
 * PCM frames for live transcription. The worklet is best-effort — if it can't
 * load, recording still works and the session falls back to batch transcription.
 */
import { PCM_WORKLET_NAME, pcmWorkletUrl } from "./pcm-worklet";

export interface AudioCaptureHandlers {
	/** Called with each 16 kHz PCM16 frame from the worklet (when available). */
	onPcmFrame?: (frame: ArrayBuffer) => void;
}

export interface StoppedAudio {
	blob: Blob;
	mimeType: string;
	bytes: number;
}

const PREFERRED_MIME = "audio/webm;codecs=opus";

export class AudioCapture {
	private stream?: MediaStream;
	private recorder?: MediaRecorder;
	private chunks: Blob[] = [];
	private ctx?: AudioContext;
	private node?: AudioWorkletNode;
	private mimeType = PREFERRED_MIME;
	/** True when the PCM worklet is live (streaming transcription is possible). */
	streaming = false;

	async start(handlers: AudioCaptureHandlers = {}): Promise<void> {
		this.stream = await navigator.mediaDevices.getUserMedia({
			audio: {
				channelCount: 1,
				echoCancellation: true,
				noiseSuppression: true,
			},
		});

		this.mimeType = MediaRecorder.isTypeSupported(PREFERRED_MIME)
			? PREFERRED_MIME
			: "audio/webm";
		this.recorder = new MediaRecorder(this.stream, { mimeType: this.mimeType });
		this.recorder.ondataavailable = (e) => {
			if (e.data.size > 0) this.chunks.push(e.data);
		};
		this.recorder.start(1000);

		if (handlers.onPcmFrame) {
			await this.startWorklet(handlers.onPcmFrame).catch((err) => {
				// worklet unavailable ⇒ no live captions; recording is unaffected.
				console.warn("debug: PCM worklet unavailable, batch fallback", err);
				this.streaming = false;
			});
		}
	}

	/**
	 * Start live PCM streaming on the ALREADY-RUNNING mic stream. Used when the
	 * user pastes an AssemblyAI key mid-recording: the recorder keeps going while
	 * the worklet attaches on top. Idempotent — returns true if streaming is (or
	 * becomes) live, false if the worklet could not load.
	 */
	async attachLiveTranscription(
		onPcmFrame: (frame: ArrayBuffer) => void,
	): Promise<boolean> {
		if (this.streaming) return true;
		try {
			await this.startWorklet(onPcmFrame);
		} catch (err) {
			console.warn("debug: PCM worklet unavailable, batch fallback", err);
			this.streaming = false;
		}
		return this.streaming;
	}

	private async startWorklet(
		onPcmFrame: (frame: ArrayBuffer) => void,
	): Promise<void> {
		if (!this.stream) return;
		const ctx = new AudioContext();
		this.ctx = ctx;
		const url = pcmWorkletUrl();
		try {
			await ctx.audioWorklet.addModule(url);
		} finally {
			URL.revokeObjectURL(url);
		}
		const source = ctx.createMediaStreamSource(this.stream);
		const node = new AudioWorkletNode(ctx, PCM_WORKLET_NAME, {
			processorOptions: { targetRate: 16000 },
		});
		node.port.onmessage = (e) => onPcmFrame(e.data as ArrayBuffer);
		// Route through a zero-gain sink so the engine keeps pulling the worklet
		// without any audible monitoring.
		const sink = ctx.createGain();
		sink.gain.value = 0;
		source.connect(node).connect(sink).connect(ctx.destination);
		this.node = node;
		this.streaming = true;
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
		void this.ctx?.close().catch(() => undefined);
		for (const track of this.stream?.getTracks() ?? []) track.stop();
		this.streaming = false;
	}
}
