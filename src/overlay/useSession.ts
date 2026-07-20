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
import { type BugToPromptClient, blobToBase64 } from "../client";
import { renderPrompt, transcriptText } from "../render";
import type {
	CaptureArtifact,
	CaptureEvent,
	CaptureSnapshot,
	InteractiveElement,
	TranscriptSegment,
} from "../schema";
import { assembleArtifact } from "./artifact/assemble";
import { AudioCapture, type StoppedAudio } from "./audio/AudioCapture";
import { StreamingTranscriber } from "./audio/StreamingTranscriber";
import { debug } from "./debug";
import { hasStoredKey, saveAssemblyKey } from "./key-store";
import {
	loadSession,
	loadShots,
	type PersistedSession,
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
	/** Ordered thumbnails for click screenshots, one per grabbed click, in click
	 *  order. Backed by object URLs created when the blob resolves and revoked on
	 *  reset/unmount. The sole data source for the review strip + latest thumb. */
	clickPreviews: Array<{
		clickNumber: number;
		screenshotRef: string;
		url: string;
	}>;
	/** Total numbered clicks recorded in the current session (onClick mode),
	 *  including clicks whose screenshot grab failed. Drives the recording click
	 *  counter so DOM-only clicks aren't undercounted vs clickPreviews. */
	clickCount: number;
	/** True when a screenshot mode was requested but the display stream could not
	 *  be acquired (denied/unavailable). Recording continues; the UI shows one
	 *  non-blocking "Screenshots unavailable" notice. */
	screenshotsUnavailable: boolean;
	error?: string;
	/** Non-fatal notice surfaced in the reviewing phase (e.g. the hosted artifact
	 *  upload failed but clipboard/download/issue still work). */
	saveWarning?: string;
	issueUrl?: string;
	start(binding: SessionBinding): Promise<boolean>;
	mark(): Promise<void>;
	stop(): Promise<void>;
	editSegment(index: number, text: string): void;
	submitIssue(override?: SessionBinding): Promise<void>;
	reset(): void;
	/** Persist an AssemblyAI key; if recording, attempt to go live immediately.
	 *  Resolves true iff live transcription engaged (or the key was stored OK
	 *  while idle). */
	provideKey(key: string): Promise<boolean>;
	voiceEnabled: boolean;
	enableVoice(): Promise<void>;
}

interface Pending {
	audioBase64: string;
	screenshotsBase64: string[];
}

const newSessionId = (): string => `cap_${crypto.randomUUID()}`;

/** Maximum audio blob size before a debug warning is emitted on stop. 8 MiB. */
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Module-level helpers extracted from stop() and rehydrate() to reduce
// cyclomatic complexity and enable isolated testing.
// ---------------------------------------------------------------------------

interface CommitTrailingPartialBag {
	partialRef: { current: string };
	finalsRef: { current: TranscriptSegment[] };
	turnStartRef: { current: number | null };
	elapsed: () => number;
	setPartial: (v: string) => void;
}

/** Flush the live-streaming partial into finalsRef so a stop mid-utterance
 *  doesn't silently drop the last spoken words. */
function commitTrailingPartial(bag: CommitTrailingPartialBag): void {
	const tail = bag.partialRef.current.trim();
	if (!tail) return;
	bag.finalsRef.current.push({
		tStartMs:
			bag.turnStartRef.current ?? bag.finalsRef.current.at(-1)?.tEndMs ?? 0,
		tEndMs: bag.elapsed(),
		text: tail,
	});
	bag.partialRef.current = "";
	bag.turnStartRef.current = null;
	bag.setPartial("");
}

/** Convert raw audio + screenshot blobs to base64 strings.
 *  Emits a debug warning (but does NOT fail) when audio exceeds MAX_AUDIO_BYTES. */
async function toBase64Payloads(
	stopped: StoppedAudio | undefined,
	shotBlobs: Array<Blob | null>,
): Promise<{ audioBase64: string; screenshotsBase64: string[] }> {
	if (stopped && stopped.blob.size > MAX_AUDIO_BYTES) {
		debug(
			`stop: audio blob ${stopped.blob.size} B exceeds MAX_AUDIO_BYTES (${MAX_AUDIO_BYTES}); upload may be slow or rejected`,
		);
	}
	const audioBase64 = stopped ? await blobToBase64(stopped.blob) : "";
	const screenshotsBase64 = await Promise.all(
		shotBlobs.map((b) => (b ? blobToBase64(b) : Promise.resolve(""))),
	);
	return { audioBase64, screenshotsBase64 };
}

interface RunBatchFallbackBag {
	client: BugToPromptClient;
	assembled: CaptureArtifact;
	workspaceId: string | undefined;
	finalsRef: { current: TranscriptSegment[] };
	artifactRef: { current: CaptureArtifact | undefined };
	setArtifact: (v: CaptureArtifact) => void;
	setTranscript: (v: TranscriptSegment[]) => void;
}

/** Run batch transcription as a fallback when live streaming produced nothing.
 *  Only adopts batch results when they contain text — an empty batch must NOT
 *  overwrite a live transcript already in finalsRef. */
async function runBatchFallback(bag: RunBatchFallbackBag): Promise<void> {
	const {
		client,
		assembled,
		workspaceId,
		finalsRef,
		artifactRef,
		setArtifact,
		setTranscript,
	} = bag;
	if (finalsRef.current.length === 0) {
		try {
			const { transcript: batch } = await client.transcribeBatch(
				assembled.sessionId,
				workspaceId,
			);
			if (batch.length > 0) {
				finalsRef.current = batch;
				const withBatch: CaptureArtifact = {
					...assembled,
					transcript: batch,
					transcriptionMode: "batch-fallback",
				};
				artifactRef.current = withBatch;
				setArtifact(withBatch);
			}
			setTranscript(finalsRef.current);
		} catch {
			setTranscript(finalsRef.current);
		}
	} else {
		setTranscript(finalsRef.current);
	}
}

/** Refs + setters bag threaded into rehydrateSession and its sub-helpers. */
interface RehydrateBag {
	// mutable refs
	sessionIdRef: { current: string };
	startEpochRef: { current: number };
	bindingRef: { current: SessionBinding };
	eventsRef: { current: CaptureEvent[] };
	snapshotsRef: { current: CaptureSnapshot[] };
	finalsRef: { current: TranscriptSegment[] };
	shotBlobsRef: { current: Array<Blob | null> };
	startPerfRef: { current: number };
	recordingRef: { current: boolean };
	grabberRef: { current: ScreenGrabber | undefined };
	screenshotModeRef: { current: ScreenshotMode };
	clickCounterRef: { current: number };
	objectUrlsRef: { current: string[] };
	clickPreviewsRef: {
		current: Array<{ clickNumber: number; screenshotRef: string; url: string }>;
	};
	// ReturnType<typeof setInterval> is an allowed exception per ts-no-return-type
	timerRef: { current: ReturnType<typeof setInterval> | undefined };
	artifactRef: { current: CaptureArtifact | undefined };
	pendingRef: { current: Pending | undefined };
	// setters (called with direct values only, never with updater functions)
	setArtifact: (v: CaptureArtifact | undefined) => void;
	setTranscript: (v: TranscriptSegment[]) => void;
	setMarkCount: (v: number) => void;
	setPhase: (v: SessionPhase) => void;
	setElapsedMs: (v: number) => void;
	setStreaming: (v: boolean) => void;
	setScreenshotsUnavailable: (v: boolean) => void;
	setClickPreviews: (
		v: Array<{ clickNumber: number; screenshotRef: string; url: string }>,
	) => void;
	setClickCount: (v: number) => void;
	// stable callbacks
	mark: () => Promise<void>;
	installListeners: (throttledMark: () => void) => void;
	elapsed: () => number;
}

/** Restore a reviewing session: reconstruct the artifact and surface it to UI. */
function restoreReviewing(
	session: PersistedSession,
	bag: Pick<
		RehydrateBag,
		| "artifactRef"
		| "pendingRef"
		| "setArtifact"
		| "setTranscript"
		| "setMarkCount"
		| "setPhase"
	>,
): void {
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
	bag.artifactRef.current = assembled;
	// Rehydrate an empty pending payload so submitIssue (which guards on
	// pendingRef) can still file after a mid-review reload: without this it stays
	// undefined and filing silently no-ops. The media was already staged
	// server-side at finalize; an empty re-upload only rewrites artifact.json
	// (with any review-time caption/target edits) and leaves the staged
	// audio/screenshots untouched (issue #105).
	bag.pendingRef.current = { audioBase64: "", screenshotsBase64: [] };
	bag.setArtifact(assembled);
	bag.setTranscript([...session.transcript]);
	bag.setMarkCount(session.snapshots.length);
	bag.setPhase("reviewing");
}

/** Resume a recording session: re-wire listeners, optionally re-acquire the
 *  screen grabber.
 *
 *  FIX (codex M4): after the screen-grabber await, the cancellation flag is
 *  re-checked; if the component unmounted during the async gap the grabber is
 *  stopped immediately so the media stream does not leak. */
async function restoreRecording(
	session: PersistedSession,
	bag: RehydrateBag,
	signal: { cancelled: boolean },
): Promise<void> {
	bag.setTranscript([...session.transcript]);
	bag.setMarkCount(session.snapshots.length);
	bag.setElapsedMs(Date.now() - session.startedAt);
	bag.recordingRef.current = true;
	bag.setStreaming(false);

	// Rehydration never re-acquires a screen grabber (see below), so a resumed
	// screenshot-enabled recording can no longer capture: mark it unavailable.
	if (bag.screenshotModeRef.current !== "off") {
		bag.setScreenshotsUnavailable(true);
	}

	// Screen capture needs a user gesture: the grabber is acquired inside
	// start() (the "Start capture" click) and getDisplayMedia cannot be
	// re-requested on resume. A rehydrated session therefore starts with no
	// grabber and no screen-share prompt; clicks stay DOM-only until stop.

	if (signal.cancelled) return;

	const throttledMark = createThrottle(() => void bag.mark(), 600);
	bag.installListeners(throttledMark);

	bag.timerRef.current = setInterval(
		() => bag.setElapsedMs(bag.elapsed()),
		250,
	);
	bag.setPhase("recording");
}

/** Attempt to restore an in-progress session from localStorage + IndexedDB.
 *  Called once on mount; the `signal` object lets the effect cancel async work
 *  when the component unmounts before completion. */
async function rehydrateSession(
	bag: RehydrateBag,
	signal: { cancelled: boolean },
): Promise<void> {
	const session = loadSession();
	if (!session) return;

	// Restore lightweight refs from the persisted snapshot.
	bag.sessionIdRef.current = session.sessionId;
	bag.startEpochRef.current = session.startedAt;
	bag.bindingRef.current = session.binding;
	bag.eventsRef.current = [...session.events];
	bag.snapshotsRef.current = [...session.snapshots];
	bag.finalsRef.current = [...session.transcript];
	// Continue click numbering from the highest persisted clickNumber so a resumed
	// session never reuses an ordinal.
	bag.clickCounterRef.current = session.events.reduce(
		(max, e) => Math.max(max, e.clickNumber ?? 0),
		0,
	);

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
	if (signal.cancelled) return;
	bag.shotBlobsRef.current = blobs;

	// Rebuild click-screenshot previews so the review strip / latest thumbnail
	// survive a reload. A persisted click carries clickNumber + screenshotRef on
	// its event; the matching blob lives at the snapshot index sharing that
	// screenshotRef. Only clicks (clickNumber set) enter the strip.
	const blobByRef = new Map<string, Blob>();
	session.snapshots.forEach((s, i) => {
		const b = blobs[i];
		if (s.screenshotRef && b) blobByRef.set(s.screenshotRef, b);
	});
	const previews = session.events
		.filter(
			(e): e is CaptureEvent & { clickNumber: number; screenshotRef: string } =>
				e.clickNumber !== undefined &&
				e.screenshotRef !== undefined &&
				blobByRef.has(e.screenshotRef),
		)
		.map((e) => {
			const url = URL.createObjectURL(blobByRef.get(e.screenshotRef) as Blob);
			bag.objectUrlsRef.current.push(url);
			return {
				clickNumber: e.clickNumber,
				screenshotRef: e.screenshotRef,
				url,
			};
		})
		.sort((a, b) => a.clickNumber - b.clickNumber);
	bag.clickPreviewsRef.current = previews;
	bag.setClickPreviews(previews);
	bag.setClickCount(bag.clickCounterRef.current);

	// Align the performance-relative start with the original wall-clock epoch
	// so elapsed() remains meaningful across a page reload.
	bag.startPerfRef.current =
		(typeof performance !== "undefined" ? performance.now() : 0) -
		(Date.now() - session.startedAt);

	if (session.status === "reviewing") {
		restoreReviewing(session, bag);
		return;
	}

	// status === "recording" — resume the live capture.
	await restoreRecording(session, bag, signal);
}

export function useSession(
	client: BugToPromptClient,
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
	const [clickPreviews, setClickPreviews] = useState<
		Array<{ clickNumber: number; screenshotRef: string; url: string }>
	>([]);
	// Numbered click count (onClick mode), including clicks whose screenshot grab
	// failed (DOM-only) — decoupled from clickPreviews, which holds only clicks
	// with a successful screenshot blob.
	const [clickCount, setClickCount] = useState(0);
	const [screenshotsUnavailable, setScreenshotsUnavailable] = useState(false);
	const [voiceEnabled, setVoiceEnabled] = useState(false);
	const [error, setError] = useState<string>();
	const [issueUrl, setIssueUrl] = useState<string>();
	const [saveWarning, setSaveWarning] = useState<string>();

	const audioRef = useRef<AudioCapture | undefined>(undefined);
	const transcriberRef = useRef<StreamingTranscriber | undefined>(undefined);
	const grabberRef = useRef<ScreenGrabber | undefined>(undefined);
	const cleanupsRef = useRef<Array<() => void>>([]);
	const eventsRef = useRef<CaptureEvent[]>([]);
	const snapshotsRef = useRef<CaptureSnapshot[]>([]);
	const shotBlobsRef = useRef<Array<Blob | null>>([]);
	const finalsRef = useRef<TranscriptSegment[]>([]);
	const partialRef = useRef("");
	// elapsed() at the first partial of the current turn — the true speech start,
	// so a segment isn't anchored at t=0 after an initial silence, and transcript
	// times share the recording clock with click/select events.
	const turnStartRef = useRef<number | null>(null);
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
	/** 1-based counter for click screenshots; assigned synchronously at click
	 *  time so numbering is deterministic regardless of grab resolution order. */
	const clickCounterRef = useRef(0);
	/** In-flight click grab promises; stop() awaits all so no numbered click is
	 *  dropped by an early assembly/upload. */
	const pendingGrabsRef = useRef<Array<Promise<void>>>([]);
	/** Object URLs backing clickPreviews; revoked on reset/unmount. */
	const objectUrlsRef = useRef<string[]>([]);
	/** Mutable mirror of clickPreviews for synchronous writes from grab callbacks. */
	const clickPreviewsRef = useRef<
		Array<{ clickNumber: number; screenshotRef: string; url: string }>
	>([]);
	/** True only while the session is actively recording; guards the click handler
	 *  from misfiring if React's concurrent-mode defers the cleanup slightly. */
	const recordingRef = useRef(false);
	/** Bumped on every start() and on unmount. start() captures its value before
	 *  awaiting the display chooser and re-checks it after; a mismatch means the
	 *  hook was superseded or unmounted during the await, so the freshly acquired
	 *  grabber must be stopped instead of installed on a dead session. */
	const startGenerationRef = useRef(0);
	/** Shared signal for the mount-once rehydrate effect; start() sets
	 *  cancelled=true to abort a concurrent rehydration so it cannot override
	 *  the new recording phase. */
	const rehydrateSignalRef = useRef<{ cancelled: boolean }>({
		cancelled: false,
	});

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

	const resolveRef = useCallback((el: Element): string | undefined => {
		const sel = cssSelector(el);
		return latestEls.current.find((e) => e.selector === sel)?.ref;
	}, []);

	const refreshSnapshotEls = useCallback((): void => {
		latestEls.current = captureInteractiveSnapshot(window).interactiveElements;
	}, []);

	/** Snapshot the current in-flight recording state, or null when no session
	 *  is active. Always tagged status "recording" — reviewing state is written
	 *  directly by stop(). */
	const buildRecordingSnapshot = useCallback((): PersistedSession | null => {
		const id = sessionIdRef.current;
		if (!id) return null;
		return {
			v: 1,
			sessionId: id,
			startedAt: startEpochRef.current,
			binding: bindingRef.current,
			status: "recording",
			events: [...eventsRef.current],
			snapshots: [...snapshotsRef.current],
			transcript: [...finalsRef.current],
			durationMs: elapsed(),
		};
	}, [elapsed]);

	/** Write the current recording state to localStorage right now, cancelling
	 *  any pending debounced write. Used at record-start (so a session that never
	 *  fires a capture event still survives a page load) and on pagehide (so the
	 *  last event isn't swallowed by the debounce window). */
	const persistNow = useCallback((): void => {
		clearTimeout(persistTimerRef.current);
		const snap = buildRecordingSnapshot();
		if (snap) saveSession(snap);
	}, [buildRecordingSnapshot]);

	/**
	 * Debounced (~400 ms) persist of the current in-flight recording state to
	 * localStorage. Called after every mutation of events / snapshots / transcript.
	 * No-op when no session is active.
	 */
	const schedulePersist = useCallback((): void => {
		clearTimeout(persistTimerRef.current);
		persistTimerRef.current = setTimeout(() => {
			// A persist scheduled during recording must not fire after stop() has
			// written the reviewing session: that would clobber it back to
			// "recording" and a reload would restore the recorder instead of the
			// review screen (thumbnail strip never returns) — issue #91.
			if (!recordingRef.current) return;
			const snap = buildRecordingSnapshot();
			if (snap) saveSession(snap);
		}, 400);
	}, [buildRecordingSnapshot]);

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
				onPartial: (t) => {
					if (turnStartRef.current === null) turnStartRef.current = elapsed();
					setPartial(t);
					partialRef.current = t;
				},
				onFinal: (turn) => {
					setPartial("");
					partialRef.current = "";
					finalsRef.current.push({
						tStartMs:
							turnStartRef.current ?? finalsRef.current.at(-1)?.tEndMs ?? 0,
						tEndMs: elapsed(),
						text: turn.text,
					});
					turnStartRef.current = null;
					setTranscript([...finalsRef.current]);
					schedulePersist();
				},
			});
			return transcriber;
		},
		[elapsed, schedulePersist],
	);

	/**
	 * Handle an accepted page click in "onClick" mode: assign a 1-based click
	 * number, reserve matching snapshot/blob slots synchronously (so interleaved
	 * route snaps or later clicks cannot take this index), then start the grab
	 * immediately. The grab promise is tracked so stop() can await it; a failed
	 * grab leaves the numbered click as DOM-only context without renumbering.
	 */
	const handlePageClick = useCallback(
		(ev: CaptureEvent, point: { x: number; y: number }): void => {
			if (!recordingRef.current) return;
			if (screenshotModeRef.current !== "onClick") return;
			const clickNumber = ++clickCounterRef.current;
			ev.clickNumber = clickNumber;
			setClickCount(clickNumber);
			const snap = captureInteractiveSnapshot(window);
			latestEls.current = snap.interactiveElements;
			const index = snapshotsRef.current.length;
			snapshotsRef.current.push({
				tMs: ev.tMs,
				viewport: snap.viewport,
				interactiveElements: snap.interactiveElements,
			});
			shotBlobsRef.current.push(null);
			setMarkCount(snapshotsRef.current.length);
			schedulePersist();

			const grabber = grabberRef.current;
			if (!grabber) return; // no display stream (e.g. resumed session)
			const grabPromise = (async () => {
				const grab = await grabber
					.grab({ point, clickNumber })
					.catch(() => null);
				if (!grab?.blob) return; // failed grab → numbered DOM-only context
				const screenshotRef = `snap-${String(index).padStart(4, "0")}.jpg`;
				const slot = snapshotsRef.current[index];
				if (slot) {
					slot.screenshotRef = screenshotRef;
					slot.screenshotMethod = grab.method;
				}
				shotBlobsRef.current[index] = grab.blob;
				ev.screenshotRef = screenshotRef;
				void putShot(sessionIdRef.current, index, grab.blob);
				const url = URL.createObjectURL(grab.blob);
				objectUrlsRef.current.push(url);
				clickPreviewsRef.current = [
					...clickPreviewsRef.current,
					{ clickNumber, screenshotRef, url },
				].sort((a, b) => a.clickNumber - b.clickNumber);
				setClickPreviews(clickPreviewsRef.current);
				setFlashTick((n) => n + 1);
				schedulePersist();
			})();
			pendingGrabsRef.current.push(grabPromise);
		},
		[schedulePersist],
	);
	/**
	 * Install the event-track listeners. Click screenshots flow through
	 * `onPageClick`; route changes reuse the throttled whole-frame snap. Populates
	 * `cleanupsRef` so the callers (start + rehydrate) share identical teardown.
	 */
	const installListeners = useCallback(
		(throttledMark: () => void): void => {
			cleanupsRef.current = [
				installEventTrack({
					onEvent: (ev) => {
						eventsRef.current.push(ev);
						schedulePersist();
						// Route-change auto-snap keeps its own throttle; no click point →
						// whole-frame fallback framing. "onMark" screenshots only on an
						// explicit Mark, so route changes must not auto-snap there.
						if (ev.kind === "route" && screenshotModeRef.current !== "onMark") {
							throttledMark();
						}
					},
					elapsedMs: elapsed,
					resolveRef,
					onPageClick: handlePageClick,
				}),
			];
		},
		[elapsed, resolveRef, schedulePersist, handlePageClick],
	);

	const mark = useCallback(async (): Promise<void> => {
		const snap = captureInteractiveSnapshot(window);
		latestEls.current = snap.interactiveElements;
		const tMs = elapsed();

		// Manual Mark / route snaps are whole-frame (no click point). Off mode or
		// no grabber → interactive snapshot only.
		let grab: { blob: Blob; method: "getDisplayMedia" } | null = null;
		if (screenshotModeRef.current !== "off") {
			grab = (await grabberRef.current?.grab()) ?? null;
		}

		const index = snapshotsRef.current.length;
		const screenshotRef = grab
			? `snap-${String(index).padStart(4, "0")}.jpg`
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
		// BugToPrompt renders <Shutter trigger={flashTick} /> which reacts to this.
		setFlashTick((n) => n + 1);
	}, [elapsed, schedulePersist]);

	const start = useCallback(
		async (binding: SessionBinding): Promise<boolean> => {
			// Kick off the display-capture request FIRST, inside the Start-capture
			// user gesture and before any await, so getDisplayMedia is allowed. Only
			// "off" skips screenshots entirely. Denial resolves a no-op grabber
			// (available:false) — recording still proceeds.
			const grabberPromise =
				screenshotModeRef.current !== "off" ? startScreenGrabber() : undefined;

			setError(undefined);
			setIssueUrl(undefined);
			setPartial("");
			partialRef.current = "";
			turnStartRef.current = null;
			setTranscript([]);
			setArtifact(undefined);
			setMarkCount(0);
			setElapsedMs(0);
			setNeedsKey(false);
			setSaveWarning(undefined);
			setScreenshotsUnavailable(false);
			// Reset click tracking + revoke any preview URLs from a prior session.
			clickCounterRef.current = 0;
			pendingGrabsRef.current = [];
			for (const url of objectUrlsRef.current) URL.revokeObjectURL(url);
			objectUrlsRef.current = [];
			clickPreviewsRef.current = [];
			setClickPreviews([]);
			setClickCount(0);
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

			setStreaming(false);
			// Cancel any in-flight rehydration immediately — if a previous reviewing
			// session was being rehydrated asynchronously, its pending setPhase call
			// must not override the recording phase we are about to set.
			rehydrateSignalRef.current.cancelled = true;
			// Mark this start() as the current generation so the post-await guard
			// below can detect a supersede (another start) or unmount that happened
			// while the display chooser was open.
			const generation = ++startGenerationRef.current;

			// Everything past here is wrapped so an unexpected failure (e.g. the
			// screen grabber throwing) surfaces as a visible error instead of a
			// rejected promise swallowed by the record button's fire-and-forget call.
			try {
				// Stop a stale grabber from a prior session, then adopt the new one.
				grabberRef.current?.stop();
				grabberRef.current = undefined;
				if (grabberPromise) {
					const grabber = await grabberPromise;
					// The hook was superseded (another start) or unmounted while the
					// display chooser was open — stop the freshly acquired stream and
					// bail before installing it on a dead session.
					if (startGenerationRef.current !== generation) {
						grabber.stop();
						// Signal the caller its continuation (e.g. enableVoice) must not
						// run: this start() was superseded/unmounted, so any follow-up
						// would leak a mic/transcriber onto a dead/replacement session.
						return false;
					}
					grabberRef.current = grabber;
					// Rebase the recording clock so the time the user spent choosing a
					// display is not counted as elapsed recording with no activity.
					startEpochRef.current = Date.now();
					startPerfRef.current =
						typeof performance !== "undefined" ? performance.now() : 0;
					setScreenshotsUnavailable(!grabber.available);
				}
				refreshSnapshotEls();
				recordingRef.current = true;

				// A throttle for route-change whole-frame snaps (click snaps go through
				// handlePageClick, un-throttled, one per click).
				const throttledMark = createThrottle(() => void mark(), 600);
				installListeners(throttledMark);

				timerRef.current = setInterval(() => setElapsedMs(elapsed()), 250);
				setPhase("recording");
				// Persist immediately so a full-page navigation that happens before
				// any capture event (the prod repro: record → click a link within a
				// few seconds, 0 marks) still leaves a session for the next page to
				// rehydrate. The debounced schedulePersist alone never fires here.
				persistNow();
				return true;
			} catch (err) {
				setError(`Could not start recording: ${(err as Error).message}`);
				setPhase("error");
				return false;
			}
		},
		[elapsed, installListeners, mark, persistNow, refreshSnapshotEls],
	);

	const enableVoice = useCallback(async (): Promise<void> => {
		if (audioRef.current) return; // already enabled
		const audio = new AudioCapture();
		audioRef.current = audio;
		let live = false;

		try {
			const token = await resolveStreamingToken(
				client,
				bindingRef.current.workspaceId,
			);
			try {
				transcriberRef.current = await makeTranscriber(token);
				live = true;
				debug("enableVoice: live transcription", { live });
				setNeedsKey(false);
			} catch (err) {
				debug("enableVoice: streaming ws failed; batch fallback", err);
				transcriberRef.current = undefined;
				live = false;
				setNeedsKey(true);
			}
		} catch (err) {
			debug("enableVoice: streaming token unavailable; batch fallback", err);
			transcriberRef.current = undefined;
			live = false;
			setNeedsKey(true);
		}

		try {
			debug("enableVoice: requesting mic");
			await audio.start(
				live ? { onPcmFrame: (f) => transcriberRef.current?.sendFrame(f) } : {},
			);
		} catch (err) {
			setError(
				`Microphone unavailable: ${(err as Error).message}. On macOS the Tauri app needs the microphone entitlement.`,
			);
			// Don't set phase to error — recording can continue without audio.
			// FIX (codex M2): also stop+clear the transcriber ws opened before the
			// mic request so it does not leak when audio.start() throws.
			transcriberRef.current?.stop();
			transcriberRef.current = undefined;
			audioRef.current = undefined;
			setVoiceEnabled(false);
			debug("enableVoice: mic unavailable", err);
			return;
		}
		setVoiceEnabled(true);
		setStreaming(live && audio.streaming);
		debug("enableVoice: enabled", { streaming: audio.streaming });
	}, [client, makeTranscriber]);

	const provideKey = useCallback(
		async (key: string): Promise<boolean> => {
			saveAssemblyKey(key);
			setHasKey(true);
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
		// Await every in-flight click grab so no numbered screenshot is dropped
		// from the assembled artifact, THEN stop the stream.
		if (pendingGrabsRef.current.length > 0) {
			await Promise.allSettled(pendingGrabsRef.current);
			pendingGrabsRef.current = [];
		}
		grabberRef.current?.stop();

		const audio = audioRef.current;
		let stopped: StoppedAudio | undefined;
		if (audio) {
			stopped = await audio.stop();
		}

		// AssemblyAI finalizes a turn only on end-of-turn (a silence gap); a
		// recording stopped mid-utterance leaves the last words in `partial`,
		// never flushed to finalsRef. Commit that trailing partial so the spoken
		// text survives into the artifact and the review screen.
		commitTrailingPartial({
			partialRef,
			finalsRef,
			turnStartRef,
			elapsed,
			setPartial,
		});

		const { audioBase64, screenshotsBase64 } = await toBase64Payloads(
			stopped,
			shotBlobsRef.current,
		);

		const assembled = assembleArtifact({
			sessionId: sessionIdRef.current,
			...bindingRef.current,
			pageUrl: window.location.href,
			startedAt: startEpochRef.current,
			durationMs: elapsed(),
			audio: stopped
				? {
						ref: "audio.webm",
						mimeType: stopped.mimeType,
						bytes: stopped.bytes,
					}
				: { ref: "", mimeType: "", bytes: 0 },
			transcript: finalsRef.current,
			events: eventsRef.current,
			snapshots: snapshotsRef.current,
			transcriptionMode:
				finalsRef.current.length > 0 ? "streaming" : "batch-fallback",
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
			// Non-fatal: the hosted artifact upload failed (e.g. 413 too large), but
			// the assembled artifact is already in memory. Proceed to review so
			// clipboard/download/file-issue still work — losing the whole capture
			// over a failed upload is the worse outcome.
			setSaveWarning(
				`Couldn't upload the capture to the server (${(err as Error).message}). Clipboard, download, and File issue still work.`,
			);
		}

		// Batch fallback runs ONLY when live transcription produced nothing — it
		// must never overwrite captions already captured (the trailing partial was
		// committed above, so finalsRef holds everything the live stream gave us).
		// A backend batch stub that returns [] must not wipe a good transcript, so
		// adopt batch results only when they actually contain text.
		await runBatchFallback({
			client,
			assembled,
			workspaceId: bindingRef.current.workspaceId,
			finalsRef,
			artifactRef,
			setArtifact,
			setTranscript,
		});

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

	const submitIssue = useCallback(
		async (override?: SessionBinding): Promise<void> => {
			const binding = override ?? bindingRef.current;
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
				// Persist caption edits AND the effective target (a late override
				// selection) before the backend reads the artifact from disk, so the
				// uploaded/rendered metadata matches the chosen project/branch rather
				// than the target frozen at record-start.
				const edited: CaptureArtifact = {
					...base,
					projectId: binding.projectId,
					workspaceId: binding.workspaceId,
					branch: binding.branch,
					transcript: finalsRef.current,
				};
				// Publish the effective artifact locally too, so history JSON and the
				// rendered branch metadata match the filed issue rather than the
				// record-start target (parity with rehydrate/finalize which set both
				// artifactRef.current and setArtifact together).
				artifactRef.current = edited;
				setArtifact(edited);
				// The hosted /issue path works without a stored artifact, so a failed
				// upload (e.g. 413 too large) must not block filing — warn and continue.
				let artifactDir: string | undefined;
				try {
					const saved = await client.saveArtifact({
						artifact: edited,
						audioBase64: pending.audioBase64,
						screenshotsBase64: pending.screenshotsBase64,
					});
					// The stored-artifact ref lets the backend link the bug to its
					// capture; empty when the fallback client has no server dir.
					if (saved.dir) artifactDir = saved.dir;
				} catch (err) {
					setSaveWarning(
						`Couldn't upload the capture to the server (${(err as Error).message}). Filing the issue without the hosted artifact.`,
					);
				}
				const transcript = transcriptText(finalsRef.current);
				const result = await client.createIssue({
					...(binding.workspaceId ? { targetId: binding.workspaceId } : {}),
					sessionId: base.sessionId,
					prompt:
						artifactDir !== undefined
							? renderPrompt(edited, { artifactDir })
							: renderPrompt(edited),
					...(artifactDir !== undefined ? { artifactRef: artifactDir } : {}),
					...(transcript ? { transcriptText: transcript } : {}),
				});
				setIssueUrl(result.url);
				// Remove the persisted session state; blobs are kept for history.
				removeSession();
				setPhase("done");
			} catch (err) {
				setError(`Failed to file issue: ${(err as Error).message}`);
				setPhase("error");
			}
		},
		[client],
	);

	const reset = useCallback((): void => {
		setPhase("idle");
		setPartial("");
		partialRef.current = "";
		turnStartRef.current = null;
		setTranscript([]);
		setArtifact(undefined);
		setMarkCount(0);
		setElapsedMs(0);
		setError(undefined);
		setIssueUrl(undefined);
		setNeedsKey(false);
		setSaveWarning(undefined);
		setScreenshotsUnavailable(false);
		// Revoke click-preview object URLs and clear the strip.
		for (const url of objectUrlsRef.current) URL.revokeObjectURL(url);
		objectUrlsRef.current = [];
		clickPreviewsRef.current = [];
		setClickPreviews([]);
		setClickCount(0);
		// Remove the persisted session state; blobs are kept for history.
		removeSession();
	}, []);

	// ---------------------------------------------------------------------------
	// Rehydrate on mount — restore an in-progress session after page navigation.
	// ---------------------------------------------------------------------------
	// biome-ignore lint/correctness/useExhaustiveDependencies: mount-once effect; all closures are stable
	useEffect(() => {
		// Store the signal in rehydrateSignalRef so start() can cancel a
		// concurrent rehydration before it overrides the new recording phase.
		rehydrateSignalRef.current = { cancelled: false };
		const signal = rehydrateSignalRef.current;

		void rehydrateSession(
			{
				sessionIdRef,
				startEpochRef,
				bindingRef,
				eventsRef,
				snapshotsRef,
				finalsRef,
				shotBlobsRef,
				startPerfRef,
				recordingRef,
				grabberRef,
				screenshotModeRef,
				clickCounterRef,
				objectUrlsRef,
				clickPreviewsRef,
				timerRef,
				artifactRef,
				pendingRef,
				setArtifact,
				setTranscript,
				setMarkCount,
				setPhase,
				setElapsedMs,
				setStreaming,
				setScreenshotsUnavailable,
				setClickPreviews,
				setClickCount,
				mark,
				installListeners,
				elapsed,
			},
			signal,
		);

		return () => {
			signal.cancelled = true;
		};
	}, []);

	// ---------------------------------------------------------------------------
	// Cleanup on unmount.
	// ---------------------------------------------------------------------------
	useEffect(() => {
		return () => {
			// Invalidate any in-flight start() awaiting the display chooser so its
			// post-await guard stops the acquired grabber instead of leaking it.
			startGenerationRef.current++;
			clearTimeout(persistTimerRef.current);
			clearInterval(timerRef.current);
			for (const off of cleanupsRef.current) off();
			transcriberRef.current?.stop();
			grabberRef.current?.stop();
			for (const url of objectUrlsRef.current) URL.revokeObjectURL(url);
		};
	}, []);

	// ---------------------------------------------------------------------------
	// Flush on page hide — a full-page navigation can fire before the 400 ms
	// debounce, so write the latest recording state synchronously. Guarded by
	// recordingRef so a reviewing session (written by stop()) is never clobbered
	// with a "recording" snapshot.
	// ---------------------------------------------------------------------------
	useEffect(() => {
		const flush = (): void => {
			if (recordingRef.current) persistNow();
		};
		window.addEventListener("pagehide", flush);
		return () => window.removeEventListener("pagehide", flush);
	}, [persistNow]);

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
		clickPreviews,
		clickCount,
		screenshotsUnavailable,
		error,
		saveWarning,
		issueUrl,
		start,
		mark,
		stop,
		editSegment,
		submitIssue,
		reset,
		provideKey,
		voiceEnabled,
		enableVoice,
	};
}
