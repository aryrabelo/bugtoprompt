/**
 * Live captions over the AssemblyAI universal-streaming websocket. The overlay
 * feeds it 16 kHz PCM frames (from {@link AudioCapture}); it emits partial turns
 * (live, editable) and finalized turns. `errored` flips on any ws failure so the
 * session knows to fall back to batch transcription of the kept recording. The
 * token is minted server-side — the long-lived key never reaches this code.
 */
import { debug } from "../debug";

export interface FinalTurn {
	text: string;
	tStartMs: number;
	tEndMs: number;
}

export interface TranscriberHandlers {
	onPartial?: (text: string) => void;
	onFinal?: (turn: FinalTurn) => void;
	onError?: (err: unknown) => void;
}

const STREAMING_WS = "wss://streaming.assemblyai.com/v3/ws";
/** Universal-3 Pro real-time model — selected via the v3 socket query param. */
const SPEECH_MODEL = "u3-rt-pro";

/** AssemblyAI v3 streaming accepts only 50–1000 ms of audio per message
 *  (error 3007 otherwise). Aggregate frames to ~100 ms before sending. */
const SEND_WINDOW_MS = 100;
const MIN_WINDOW_MS = 50;

export class StreamingTranscriber {
	private ws?: WebSocket;
	private open = false;
	private warnedClosed = false;
	/** Set on any ws error — the session reads it to decide on batch fallback. */
	errored = false;
	private startedAt = 0;
	private lastFinalMs = 0;
	/** Negotiated sample rate (Hz); set in start(). Drives the send-window math. */
	private rate = 16000;
	/** PCM16 frames buffered until they span SEND_WINDOW_MS, then flushed as one. */
	private pending: Uint8Array[] = [];
	private pendingBytes = 0;

	/** Open the streaming ws. Resolves once connected (or rejects on failure). */
	start(
		token: string,
		sampleRate: number,
		handlers: TranscriberHandlers = {},
	): Promise<void> {
		this.startedAt = typeof performance !== "undefined" ? performance.now() : 0;
		const rate = Math.round(sampleRate) || 16000;
		this.rate = rate;
		const url = `${STREAMING_WS}?sample_rate=${rate}&speech_model=${SPEECH_MODEL}&token=${encodeURIComponent(token)}`;
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		let settled = false;
		const ws = new WebSocket(url);
		ws.binaryType = "arraybuffer";
		this.ws = ws;
		ws.onopen = () => {
			this.open = true;
			debug("transcriber ws open");
			settled = true;
			resolve();
		};
		ws.onerror = (e) => {
			this.errored = true;
			debug("transcriber ws error", e);
			handlers.onError?.(e);
			if (!settled) {
				settled = true;
				reject(new Error("streaming websocket failed to open"));
			}
		};
		ws.onclose = (e) => {
			this.open = false;
			this.pending = [];
			this.pendingBytes = 0;
			debug("transcriber ws closed", { code: e.code, reason: e.reason });
		};
		ws.onmessage = (ev) => this.onMessage(ev, handlers);
		return promise;
	}

	private now(): number {
		const t = typeof performance !== "undefined" ? performance.now() : 0;
		return Math.max(0, t - this.startedAt);
	}

	private onMessage(ev: MessageEvent, handlers: TranscriberHandlers): void {
		if (typeof ev.data !== "string") return;
		let msg: Record<string, unknown>;
		try {
			msg = JSON.parse(ev.data) as Record<string, unknown>;
		} catch {
			return; // keepalive / non-json
		}
		const text =
			(typeof msg.transcript === "string" && msg.transcript) ||
			(typeof msg.text === "string" && msg.text) ||
			"";
		if (!text) return;
		const isFinal =
			msg.end_of_turn === true ||
			msg.message_type === "FinalTranscript" ||
			msg.type === "FinalTranscript";
		if (isFinal) {
			const end = this.now();
			handlers.onFinal?.({
				text,
				tStartMs: this.lastFinalMs,
				tEndMs: end,
			});
			this.lastFinalMs = end;
		} else {
			handlers.onPartial?.(text);
		}
	}

	/**
	 * Buffer one PCM16 frame and flush to the ws in ~100 ms batches.
	 *
	 * AssemblyAI's v3 streaming API rejects any audio message outside a
	 * 50–1000 ms window (error 3007). The AudioWorklet tap emits ~2.7 ms render
	 * quanta, so forwarding each one verbatim trips that limit and the socket
	 * closes before a single word is transcribed. Aggregating to ~100 ms keeps
	 * every message inside the window. No-op while the ws isn't open.
	 */
	sendFrame(frame: ArrayBuffer): void {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			if (!this.warnedClosed) {
				this.warnedClosed = true;
				debug("sendFrame: socket not OPEN, dropping frames", {
					readyState: this.ws?.readyState,
				});
			}
			return;
		}
		this.pending.push(new Uint8Array(frame));
		this.pendingBytes += frame.byteLength;
		if (this.pendingBytes >= this.windowBytes(SEND_WINDOW_MS)) this.flush();
	}

	/** Bytes of mono PCM16 at the negotiated rate spanning `ms` of audio. */
	private windowBytes(ms: number): number {
		return Math.round((this.rate * 2 * ms) / 1000);
	}

	/** Concatenate buffered frames into one ws message; clears the buffer. */
	private flush(): void {
		if (this.pendingBytes === 0) return;
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			this.pending = [];
			this.pendingBytes = 0;
			return;
		}
		const merged = new Uint8Array(this.pendingBytes);
		let offset = 0;
		for (const chunk of this.pending) {
			merged.set(chunk, offset);
			offset += chunk.length;
		}
		this.pending = [];
		this.pendingBytes = 0;
		try {
			this.ws.send(merged.buffer);
		} catch {
			this.errored = true;
		}
	}

	/** Politely terminate the session and close the socket. */
	stop(): void {
		// Flush a trailing partial batch only if it clears the 50 ms floor; a
		// shorter tail would itself be rejected (error 3007), so drop it.
		if (this.pendingBytes >= this.windowBytes(MIN_WINDOW_MS)) this.flush();
		this.pending = [];
		this.pendingBytes = 0;
		try {
			if (this.ws && this.open) {
				this.ws.send(JSON.stringify({ type: "Terminate" }));
			}
		} catch {
			// ignore — we're closing anyway
		}
		this.ws?.close();
		this.open = false;
	}
}
