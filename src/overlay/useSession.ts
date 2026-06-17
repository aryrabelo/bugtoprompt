/**
 * The capture session engine. Owns the imperative pieces (mic capture, live
 * transcriber, screen grabber, event/click/route listeners) and exposes a small
 * state machine to the overlay UI:
 *
 *   idle → recording → (saving) → reviewing → (saving) → done
 *
 * On stop the kept recording + screenshots + snapshots are persisted; when live
 * streaming was unavailable or dropped, the transcript is reconstructed by batch
 * transcription. In review the user can edit captions before filing the issue.
 *
 * Persistence: active sessions survive full-page navigations via localStorage +
 * IndexedDB. On mount the hook checks for an in-progress session and rehydrates
 * it without requiring the user to re-start.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { blobToBase64, type SnapPromptClient } from "../client";
import { renderPrompt } from "../render";
import type {
	CaptureArtifact,
	CaptureEvent,
	CaptureSnapshot,
	InteractiveElement,
	TranscriptSegment,
} from "../schema";
import { assembleArtifact } from "./artifact/assemble";
import { AudioCapture } from "./audio/AudioCapture";
import { StreamingTranscriber } from "./audio/StreamingTranscriber";
import { hasStoredKey, saveAssemblyKey } from "./key-store";
import {
	loadSession,
	loadShots,
	putShot,
	removeSession,
	type ScreenshotMode,
	type SessionBinding,
	saveSession,
} from "./session-store";
import { createThrottle } from "./snap/throttle";
import { captureInteractiveSnapshot } from "./snapshot/buildInteractiveSnapshot";
import { type ScreenGrabber, startScreenGrabber } from "./snapshot/screenshot";
import { cssSelector } from "./snapshot/selector";
import { resolveStreamingToken } from "./streaming-auth";
import { installEventTrack } from "./timeline/eventTrack";

// Re-export so callers can import SessionBinding and ScreenshotMode from
// either useSession or session-store without changing import paths.
export type { ScreenshotMode, SessionBinding } from "./session-store";

export type SessionPhase =
	| "idle"
	| "recording"
	| "saving"
	| "reviewing"
	| "done"
	| "error";

export interface UseSessionResult {
	phase: SessionPhase;
	partial: string;
	transcript: TranscriptSegment[];
	/** The artifact captured on stop — available in reviewing/done phases. */
	artifact?: CaptureArtifact;
	markCount: number;
	elapsedMs: number;
	streaming: boolean;
	/** True when live transcription could not start because no usable streaming
	 *  token / API key resolved — prompt the user to paste an AssemblyAI key. */
	needsKey: boolean;
	/** Reactive mirror of hasStoredKey(): true once a usable streaming
	 *  credential is configured for this tab. Flips on after provideKey saves a
	 *  key so the idle key-prompt hides immediately. */
	hasKey: boolean;
	/** Incremented after each grab resolves — drives the Shutter flash. */
	flashTick: number;
	/** Whether document clicks auto-trigger mark() while recording. Default: true. */
	snapOnClick: boolean;
	error?: string;
	issueUrl?: string;
	start(binding: SessionBinding): Promise<void>;
	mark(): Promise<void>;
	stop(): Promise<void>;
	editSegment(index: number, text: string): void;
	submitIssue(): Promise<void>;
	reset(): void;
	/** Persist an AssemblyAI key; if recording, attempt to go live immediately.
	 *  Resolves true iff live transcription engaged (or the key was stored OK
	 *  while idle). */
	provideKey(key: string): Promise<boolean>;
	setSnapOnClick(v: boolean): void;
}

interface Pending {
	audioBase64: string;
	screenshotsBase64: string[];
}

const newSessionId = (): string => `cap_${crypto.randomUUID()}`;

export function useSession(
	client: SnapPromptClient,
	screenshotMode: ScreenshotMode = "onMark",
): UseSessionResult {
	const [phase, setPhase] = useState<SessionPhase>("idle");
	const [partial, setPartial] = useState("");
	const [transcript, setTranscript] = useState<TranscriptSegment[]>([]);
	const [artifact, setArtifact] = useState<CaptureArtifact | undefined>(
		undefined,
	);
	const [markCount, setMarkCount] = useState(0);
	const [elapsedMs, setElapsedMs] = useState(0);
	const [streaming, setStreaming] = useState(false);
	const [needsKey, setNeedsKey] = useState(false);
	const [hasKey, setHasKey] = useState<boolean>(() => hasStoredKey());
	const [flashTick, setFlashTick] = useState(0);
	const [snapOnClickState, setSnapOnClickState] = useState(true);
	const [error, setError] = useState<string>();
	const [issueUrl, setIssueUrl] = useState<string>();

	const audioRef = useRef<AudioCapture | undefined>(undefined);
	const transcriberRef = useRef<StreamingTranscriber | undefined>(undefined);
	const grabberRef = useRef<ScreenGrabber | undefined>(undefined);
	const cleanupsRef = useRef<Array<() => void>>([]);
	const eventsRef = useRef<CaptureEvent[]>([]);
	const snapshotsRef = useRef<CaptureSnapshot[]>([]);
	const shotBlobsRef = useRef<Array<Blob | null>>([]);
	const finalsRef = useRef<TranscriptSegment[]>([]);
	const latestEls = useRef<InteractiveElement[]>([]);
	const sessionIdRef = useRef<string>("");
	const bindingRef = useRef<SessionBinding>({});
	const startEpochRef = useRef(0);
	const startPerfRef = useRef(0);
	// ReturnType<typeof setInterval> is an allowed exception per ts-no-return-type
	const timerRef = useRef<ReturnType<typeof setInterval> | undefined>(
		undefined,
	);
	// ReturnType<typeof setTimeout> is an allowed exception per ts-no-return-type
	const persistTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
		undefined,
	);
	const artifactRef = useRef<CaptureArtifact | undefined>(undefined);
	const pendingRef = useRef<Pending | undefined>(undefined);
	const snapOnClickRef = useRef(true);
	/** True only while the session is actively recording; guards the click handler
	 *  from misfiring if React's concurrent-mode defers the cleanup slightly. */
	const recordingRef = useRef(false);

	// Keep screenshotMode accessible in async callbacks without requiring them
	// to re-close over the prop on each render.
	const screenshotModeRef = useRef<ScreenshotMode>(screenshotMode);
	screenshotModeRef.current = screenshotMode;

	const elapsed = useCallback(
		() =>
			(typeof performance !== "undefined" ? performance.now() : 0) -
			startPerfRef.current,
		[],
	);

	/**
	 * Keeps snapOnClickRef in sync without requiring the click listener to be
	 * reinstalled each time the toggle changes.
	 */
	const setSnapOnClick = useCallback((v: boolean): void => {
		snapOnClickRef.current = v;
		setSnapOnClickState(v);
	}, []);

	const resolveRef = useCallback((el: Element): string | undefined => {
		const sel = cssSelector(el);
		return latestEls.current.find((e) => e.selector === sel)?.ref;
	}, []);

	const refreshSnapshotEls = useCallback((): void => {
		latestEls.current = captureInteractiveSnapshot(window).interactiveElements;
	}, []);

	/**
	 * Debounced (~400 ms) persist of the current in-flight recording state to
	 * localStorage. Called after every mutation of events / snapshots / transcript.
	 * No-op when no session is active.
	 */
	const schedulePersist = useCallback((): void => {
		clearTimeout(persistTimerRef.current);
		persistTimerRef.current = setTimeout(() => {
			const id = sessionIdRef.current;
			if (!id) return;
			saveSession({
				v: 1,
				sessionId: id,
				startedAt: startEpochRef.current,
				binding: bindingRef.current,
				status: "recording",
				events: [...eventsRef.current],
				snapshots: [...snapshotsRef.current],
				transcript: [...finalsRef.current],
				durationMs: elapsed(),
			});
		}, 400);
	}, [elapsed]);

	/**
	 * Build and open a StreamingTranscriber wired to the standard partial/final
	 * handlers. Shared by start(), provideKey(), and the rehydrate effect so the
	 * caption-handling logic lives in exactly one place. Resolves the connected
	 * transcriber (or rejects if the ws fails to open).
	 */
	const makeTranscriber = useCallback(
		async (token: string): Promise<StreamingTranscriber> => {
			const transcriber = new StreamingTranscriber();
			await transcriber.start(token, 16000, {
				onPartial: (t) => setPartial(t),
				onFinal: (turn) => {
					setPartial("");
					finalsRef.current.push({
						tStartMs: turn.tStartMs,
						tEndMs: turn.tEndMs,
						text: turn.text,
					});
					setTranscript([...finalsRef.current]);
					schedulePersist();
				},
			});
			return transcriber;
		},
		[schedulePersist],
	);

	/**
	 * Install the click handler and event-track listeners. Populates
	 * `cleanupsRef` so the callers (start + rehydrate) share identical teardown.
	 */
	const installListeners = useCallback(
		(throttledMark: () => void): void => {
			const handleClick = (e: MouseEvent): void => {
				if (!recordingRef.current) return;
				if (!snapOnClickRef.current) return;
				// Ignore clicks whose target is inside the overlay itself.
				if ((e.target as Element).closest?.("[data-snap-prompt]")) return;
				throttledMark();
			};
			document.addEventListener("click", handleClick, { capture: true });

			cleanupsRef.current = [
				installEventTrack({
					onEvent: (ev) => {
						eventsRef.current.push(ev);
						schedulePersist();
						// Route-change auto-snap is always on (not gated by snapOnClick).
						if (ev.kind === "route") throttledMark();
					},
					elapsedMs: elapsed,
					resolveRef,
				}),
				() =>
					document.removeEventListener("click", handleClick, {
						capture: true,
					}),
			];
		},
		[elapsed, resolveRef, schedulePersist],
	);

	const mark = useCallback(async (): Promise<void> => {
		const snap = captureInteractiveSnapshot(window);
		latestEls.current = snap.interactiveElements;
		const tMs = elapsed();

		// Determine screenshot grab based on mode.
		let grab: { blob: Blob; method: "getDisplayMedia" } | null = null;
		if (screenshotModeRef.current !== "off") {
			// Lazy-init the grabber when rehydrating with "onMark" mode (it was not
			// pre-acquired on rehydrate; acquire on the first explicit mark instead).
			if (
				grabberRef.current === undefined &&
				screenshotModeRef.current === "onMark"
			) {
				grabberRef.current = await startScreenGrabber();
			}
			grab = (await grabberRef.current?.grab()) ?? null;
		}

		const index = snapshotsRef.current.length;
		const screenshotRef = grab
			? `snap-${String(index).padStart(4, "0")}.png`
			: undefined;
		snapshotsRef.current.push({
			tMs,
			...(screenshotRef
				? { screenshotRef, screenshotMethod: grab?.method }
				: {}),
			viewport: snap.viewport,
			interactiveElements: snap.interactiveElements,
		});
		shotBlobsRef.current.push(grab?.blob ?? null);
		eventsRef.current.push({ tMs, kind: "mark" });

		// Persist the blob immediately; schedule a lightweight state persist.
		if (grab?.blob) {
			void putShot(sessionIdRef.current, index, grab.blob);
		}
		schedulePersist();

		setMarkCount(snapshotsRef.current.length);
		// Flash signal: emitted AFTER grab() resolves and the snapshot is pushed.
		// SnapPrompt renders <Shutter trigger={flashTick} /> which reacts to this.
		setFlashTick((n) => n + 1);
	}, [elapsed, schedulePersist]);

	const start = useCallback(
		async (binding: SessionBinding): Promise<void> => {
			setError(undefined);
			setIssueUrl(undefined);
			setPartial("");
			setTranscript([]);
			setArtifact(undefined);
			setMarkCount(0);
			setElapsedMs(0);
			setNeedsKey(false);
			eventsRef.current = [];
			snapshotsRef.current = [];
			shotBlobsRef.current = [];
			finalsRef.current = [];
			latestEls.current = [];
			bindingRef.current = binding;
			sessionIdRef.current = newSessionId();
			startEpochRef.current = Date.now();
			startPerfRef.current =
				typeof performance !== "undefined" ? performance.now() : 0;

			const audio = new AudioCapture();
			audioRef.current = audio;
			let live = false;

			// Best-effort live transcription: mint a token, open the ws. Any failure
			// degrades to record-only (batch transcription happens on stop).
			try {
				const token = await resolveStreamingToken(client, binding.workspaceId);
				try {
					transcriberRef.current = await makeTranscriber(token);
					live = true;
					setNeedsKey(false);
				} catch (err) {
					// Token minted but the streaming websocket failed to open.
					console.warn(
						"debug: streaming websocket failed to open; batch fallback",
						err,
					);
					transcriberRef.current = undefined;
					live = false;
					setNeedsKey(true);
				}
			} catch (err) {
				// No usable streaming token resolved (no key / mint failed).
				console.warn(
					"debug: streaming token unavailable; prompting for API key (batch fallback)",
					err,
				);
				transcriberRef.current = undefined;
				live = false;
				setNeedsKey(true);
			}

			try {
				await audio.start(
					live
						? { onPcmFrame: (f) => transcriberRef.current?.sendFrame(f) }
						: {},
				);
			} catch (err) {
				setError(
					`Microphone unavailable: ${(err as Error).message}. On macOS the Tauri app needs the microphone entitlement.`,
				);
				setPhase("error");
				return;
			}
			setStreaming(live && audio.streaming);

			// Acquire the screen grabber unless screenshots are disabled.
			if (screenshotModeRef.current !== "off") {
				grabberRef.current = await startScreenGrabber();
			} else {
				grabberRef.current = undefined;
			}
			refreshSnapshotEls();
			recordingRef.current = true;

			// ONE shared throttle for both click and route-change triggers so bursts
			// (e.g. a click that also triggers a pushState) coalesce into one snap.
			const throttledMark = createThrottle(() => void mark(), 600);
			installListeners(throttledMark);

			timerRef.current = setInterval(() => setElapsedMs(elapsed()), 250);
			setPhase("recording");
		},
		[
			client,
			elapsed,
			installListeners,
			makeTranscriber,
			mark,
			refreshSnapshotEls,
		],
	);

	const provideKey = useCallback(
		async (key: string): Promise<boolean> => {
			saveAssemblyKey(key);
			const audio = audioRef.current;
			if (recordingRef.current && !transcriberRef.current && audio) {
				try {
					const token = await resolveStreamingToken(
						client,
						bindingRef.current.workspaceId,
					);
					transcriberRef.current = await makeTranscriber(token);
					const ok = await audio.attachLiveTranscription((f) =>
						transcriberRef.current?.sendFrame(f),
					);
					setStreaming(ok);
					setNeedsKey(!ok);
					return ok;
				} catch {
					setNeedsKey(true);
					return false;
				}
			}
			// Not recording — the key is stored for the next capture.
			setNeedsKey(false);
			return true;
		},
		[client, makeTranscriber],
	);

	const stop = useCallback(async (): Promise<void> => {
		setPhase("saving");
		recordingRef.current = false;
		clearInterval(timerRef.current);
		for (const off of cleanupsRef.current) off();
		cleanupsRef.current = [];
		transcriberRef.current?.stop();
		grabberRef.current?.stop();

		const audio = audioRef.current;
		if (!audio) {
			setPhase("error");
			setError("no active recording");
			return;
		}
		const stopped = await audio.stop();
		const live = audio.streaming && !transcriberRef.current?.errored;

		const audioBase64 = await blobToBase64(stopped.blob);
		const screenshotsBase64 = await Promise.all(
			shotBlobsRef.current.map((b) =>
				b ? blobToBase64(b) : Promise.resolve(""),
			),
		);

		const assembled = assembleArtifact({
			sessionId: sessionIdRef.current,
			...bindingRef.current,
			pageUrl: window.location.href,
			startedAt: startEpochRef.current,
			durationMs: elapsed(),
			audio: {
				ref: "audio.webm",
				mimeType: stopped.mimeType,
				bytes: stopped.bytes,
			},
			transcript: finalsRef.current,
			events: eventsRef.current,
			snapshots: snapshotsRef.current,
			transcriptionMode: live ? "streaming" : "batch-fallback",
		});
		artifactRef.current = assembled;
		setArtifact(assembled);
		pendingRef.current = { audioBase64, screenshotsBase64 };

		try {
			await client.saveArtifact({
				artifact: assembled,
				audioBase64,
				screenshotsBase64,
			});
		} catch (err) {
			setError(`Failed to save capture: ${(err as Error).message}`);
			setPhase("error");
			return;
		}

		if (!live) {
			// Reconstruct the transcript from the kept recording. Non-fatal: a
			// capture without transcription (e.g. no ASSEMBLYAI_API_KEY) still has
			// the audio, clicks, and snapshots.
			try {
				const { transcript: batch } = await client.transcribeBatch(
					assembled.sessionId,
					bindingRef.current.workspaceId,
				);
				finalsRef.current = batch;
				const withBatch: CaptureArtifact = {
					...assembled,
					transcript: batch,
					transcriptionMode: "batch-fallback",
				};
				artifactRef.current = withBatch;
				setArtifact(withBatch);
				setTranscript(batch);
			} catch {
				setTranscript(finalsRef.current);
			}
		} else {
			setTranscript(finalsRef.current);
		}

		// Persist the reviewing state so a cross-page navigation can still
		// surface the assembled artifact for export.
		saveSession({
			v: 1,
			sessionId: sessionIdRef.current,
			startedAt: startEpochRef.current,
			binding: bindingRef.current,
			status: "reviewing",
			events: eventsRef.current,
			snapshots: snapshotsRef.current,
			transcript: finalsRef.current,
			durationMs: elapsed(),
		});

		setPhase("reviewing");
	}, [client, elapsed]);

	const editSegment = useCallback((index: number, text: string): void => {
		setTranscript((prev) => {
			const next = prev.map((s, i) =>
				i === index ? { ...s, text, edited: true } : s,
			);
			finalsRef.current = next;
			return next;
		});
	}, []);

	const submitIssue = useCallback(async (): Promise<void> => {
		const binding = bindingRef.current;
		const base = artifactRef.current;
		const pending = pendingRef.current;
		if (!binding.projectId) {
			setError("No project selected — pick a target before filing.");
			setPhase("error");
			return;
		}
		if (!base || !pending) return;
		setPhase("saving");
		try {
			// Persist any caption edits before the backend reads the artifact from disk.
			const edited: CaptureArtifact = {
				...base,
				transcript: finalsRef.current,
			};
			await client.saveArtifact({
				artifact: edited,
				audioBase64: pending.audioBase64,
				screenshotsBase64: pending.screenshotsBase64,
			});
			const result = await client.createIssue({
				projectId: binding.projectId,
				...(binding.workspaceId ? { targetId: binding.workspaceId } : {}),
				sessionId: base.sessionId,
				prompt: renderPrompt(edited),
			});
			setIssueUrl(result.url);
			// Remove the persisted session state; blobs are kept for history.
			removeSession();
			setPhase("done");
		} catch (err) {
			setError(`Failed to file issue: ${(err as Error).message}`);
			setPhase("error");
		}
	}, [client]);

	const reset = useCallback((): void => {
		setPhase("idle");
		setPartial("");
		setTranscript([]);
		setArtifact(undefined);
		setMarkCount(0);
		setElapsedMs(0);
		setError(undefined);
		setIssueUrl(undefined);
		setNeedsKey(false);
		// Remove the persisted session state; blobs are kept for history.
		removeSession();
	}, []);

	// ---------------------------------------------------------------------------
	// Rehydrate on mount — restore an in-progress session after page navigation.
	// ---------------------------------------------------------------------------
	// biome-ignore lint/correctness/useExhaustiveDependencies: mount-once effect; all closures are stable
	useEffect(() => {
		let cancelled = false;

		const rehydrate = async (): Promise<void> => {
			const session = loadSession();
			if (!session) return;

			// Restore lightweight refs from the persisted snapshot.
			sessionIdRef.current = session.sessionId;
			startEpochRef.current = session.startedAt;
			bindingRef.current = session.binding;
			eventsRef.current = [...session.events];
			snapshotsRef.current = [...session.snapshots];
			finalsRef.current = [...session.transcript];

			// Load screenshot blobs from IndexedDB. If the store is missing/corrupt,
			// continue with null placeholders so startup does not crash.
			let blobs: Array<Blob | null>;
			try {
				blobs = await loadShots(session.sessionId, session.snapshots.length);
			} catch (err) {
				console.warn(
					"debug: screenshot store unavailable during rehydrate; continuing without stored shots",
					err,
				);
				blobs = Array.from({ length: session.snapshots.length }, () => null);
			}
			if (cancelled) return;
			shotBlobsRef.current = blobs;

			// Align the performance-relative start with the original wall-clock epoch
			// so elapsed() remains meaningful across a page reload.
			startPerfRef.current =
				(typeof performance !== "undefined" ? performance.now() : 0) -
				(Date.now() - session.startedAt);

			if (session.status === "reviewing") {
				// Reconstruct a minimal artifact for clipboard / download export.
				// Audio was already saved server-side; use a placeholder so the schema
				// validates while renderPrompt (which uses transcript + events) works.
				const assembled = assembleArtifact({
					sessionId: session.sessionId,
					...session.binding,
					pageUrl: typeof window !== "undefined" ? window.location.href : "",
					startedAt: session.startedAt,
					durationMs: session.durationMs,
					audio: { ref: "audio.webm", mimeType: "audio/webm", bytes: 0 },
					transcript: session.transcript,
					events: session.events,
					snapshots: session.snapshots,
					transcriptionMode: "streaming",
				});
				artifactRef.current = assembled;
				setArtifact(assembled);
				setTranscript([...session.transcript]);
				setMarkCount(session.snapshots.length);
				setPhase("reviewing");
				return;
			}

			// status === "recording" — resume the live capture.
			setTranscript([...session.transcript]);
			setMarkCount(session.snapshots.length);
			setElapsedMs(Date.now() - session.startedAt);
			recordingRef.current = true;

			// Re-acquire audio / live-transcription best-effort.
			// MediaStream cannot survive a hard reload — each page opens its own.
			// On failure, continue silent (the event / snapshot timeline still works).
			const audio = new AudioCapture();
			audioRef.current = audio;
			let live = false;
			try {
				const { token } = await client.mintStreamingToken(
					session.binding.workspaceId,
				);
				if (!cancelled) {
					transcriberRef.current = await makeTranscriber(token);
					live = true;
				}
			} catch {
				live = false;
			}
			try {
				await audio.start(
					live
						? { onPcmFrame: (f) => transcriberRef.current?.sendFrame(f) }
						: {},
				);
			} catch {
				// Continue without audio — do not set phase to error on rehydrate.
			}
			if (!cancelled) setStreaming(live && audio.streaming);

			// Screen grabber acquisition depends on mode.
			// "perPage"  → re-prompt immediately so marks on this page screenshot.
			// "onMark"   → lazy: grabberRef stays undefined; mark() will acquire it.
			// "off"      → never acquire the grabber.
			if (screenshotModeRef.current === "perPage" && !cancelled) {
				grabberRef.current = await startScreenGrabber();
			}

			if (cancelled) return;

			const throttledMark = createThrottle(() => void mark(), 600);
			installListeners(throttledMark);

			timerRef.current = setInterval(() => setElapsedMs(elapsed()), 250);
			setPhase("recording");
		};

		void rehydrate();

		return () => {
			cancelled = true;
		};
	}, []);

	// ---------------------------------------------------------------------------
	// Cleanup on unmount.
	// ---------------------------------------------------------------------------
	useEffect(() => {
		return () => {
			clearTimeout(persistTimerRef.current);
			clearInterval(timerRef.current);
			for (const off of cleanupsRef.current) off();
			transcriberRef.current?.stop();
			grabberRef.current?.stop();
		};
	}, []);

	return {
		phase,
		partial,
		transcript,
		artifact,
		markCount,
		elapsedMs,
		streaming,
		needsKey,
		hasKey,
		flashTick,
		snapOnClick: snapOnClickState,
		error,
		issueUrl,
		start,
		mark,
		stop,
		editSegment,
		submitIssue,
		reset,
		provideKey,
		setSnapOnClick,
	};
}
