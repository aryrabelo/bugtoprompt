import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { Mock } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BugToPromptClient, Target } from "../client";
import { loadSession, putShot, saveSession } from "./session-store";
import { startScreenGrabber } from "./snapshot/screenshot";
import { useSession } from "./useSession";
import { deferred } from "./util/deferred";

// ---------------------------------------------------------------------------
// Mock instances (configured fresh in beforeEach; factories close over these)
// ---------------------------------------------------------------------------

interface MockAudioInstance {
	streaming: boolean;
	start: Mock;
	stop: Mock;
	sampleRate: Mock;
	attachLiveTranscription: Mock;
}

interface MockTranscriberInstance {
	errored: boolean;
	start: Mock;
	stop: Mock;
	sendFrame: Mock;
	handlers?: {
		onPartial?: (t: string) => void;
		onFinal?: (turn: {
			text: string;
			tStartMs: number;
			tEndMs: number;
		}) => void;
	};
}

let mockAudioInstance: MockAudioInstance;
let mockTranscriberInstance: MockTranscriberInstance;

// vi.hoisted ensures this object exists before the vi.mock factories run
const mockGrabber = vi.hoisted(() => ({
	available: true,
	grab: vi.fn().mockResolvedValue(null),
	stop: vi.fn(),
}));

vi.mock("./audio/AudioCapture", () => ({
	AudioCapture: vi.fn().mockImplementation(() => mockAudioInstance),
}));

vi.mock("./audio/StreamingTranscriber", () => ({
	StreamingTranscriber: vi
		.fn()
		.mockImplementation(() => mockTranscriberInstance),
}));

vi.mock("./snapshot/screenshot", () => ({
	startScreenGrabber: vi.fn().mockResolvedValue(mockGrabber),
}));

// renderPrompt is pure but may vary with artifact content — mock it to keep
// tests deterministic and independent of the render module.
vi.mock("../render", () => ({
	renderPrompt: vi.fn().mockReturnValue("## mocked prompt"),
	transcriptText: vi.fn().mockReturnValue(""),
}));

// ---------------------------------------------------------------------------
// Fake BugToPromptClient
// ---------------------------------------------------------------------------

function makeFakeClient(
	overrides: Partial<BugToPromptClient> = {},
): BugToPromptClient {
	return {
		mintStreamingToken: vi
			.fn()
			.mockResolvedValue({ token: "tok", expiresAt: 0 }),
		saveArtifact: vi
			.fn()
			.mockResolvedValue({ dir: "/tmp/cap", sessionId: "s1" }),
		transcribeBatch: vi.fn().mockResolvedValue({
			transcript: [{ tStartMs: 0, tEndMs: 1000, text: "batch" }],
		}),
		createIssue: vi
			.fn()
			.mockResolvedValue({ created: true, number: 42, url: "https://gh/1" }),
		listTargets: vi.fn().mockResolvedValue([] as Target[]),
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
	vi.clearAllMocks();
	// Prevent a persisted session from a previous test from triggering rehydration.
	localStorage.clear();
	// Clear any window config hint leaked by a prior test (e.g. provideKey).
	delete window.__BUGTOPROMPT__;

	// Default audio mock: streaming=true only when onPcmFrame is provided (live path)
	mockAudioInstance = {
		streaming: false,
		start: vi
			.fn()
			.mockImplementation(async (handlers: { onPcmFrame?: unknown } = {}) => {
				mockAudioInstance.streaming = !!handlers.onPcmFrame;
			}),
		stop: vi.fn().mockResolvedValue({
			blob: new Blob([]),
			mimeType: "audio/webm",
			bytes: 0,
		}),
		sampleRate: vi.fn().mockReturnValue(16000),
		attachLiveTranscription: vi.fn().mockResolvedValue(true),
	};

	// Default transcriber: not errored
	mockTranscriberInstance = {
		errored: false,
		start: vi.fn().mockImplementation((_t, _r, handlers) => {
			mockTranscriberInstance.handlers = handlers;
			return Promise.resolve();
		}),
		stop: vi.fn(),
		sendFrame: vi.fn(),
	};

	mockGrabber.grab.mockResolvedValue(null);
	mockGrabber.stop.mockReset();
	mockGrabber.available = true;
	// Ensure startScreenGrabber resolves the shared grabber (a prior test may
	// have overridden it for the denial case).
	(startScreenGrabber as unknown as Mock).mockResolvedValue(mockGrabber);
	// jsdom does not implement object-URL APIs the click-preview path needs.
	URL.createObjectURL = vi.fn(() => `blob:mock-${Math.random()}`);
	URL.revokeObjectURL = vi.fn();
});

// Unmount every rendered hook so its listeners (installEventTrack, grabber) are
// torn down and cannot leak clicks/grabs into a later test.
afterEach(() => {
	cleanup();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useSession", () => {
	it("(a) transitions idle → recording after start({})", async () => {
		const client = makeFakeClient();
		const { result } = renderHook(() => useSession(client));

		expect(result.current.phase).toBe("idle");

		await act(async () => {
			await result.current.start({});
		});

		expect(result.current.phase).toBe("recording");
	});

	it("(b) recording → reviewing → done with issueUrl", async () => {
		const client = makeFakeClient();
		const { result } = renderHook(() => useSession(client));

		await act(async () => {
			await result.current.start({ projectId: "proj" });
		});
		expect(result.current.phase).toBe("recording");

		await act(async () => {
			await result.current.stop();
		});
		expect(result.current.phase).toBe("reviewing");

		await act(async () => {
			await result.current.submitIssue();
		});
		expect(result.current.phase).toBe("done");
		expect(result.current.issueUrl).toBe("https://gh/1");
	});

	it("(b2) submitIssue forwards prompt + artifactRef to createIssue", async () => {
		const client = makeFakeClient();
		const { result } = renderHook(() => useSession(client));

		await act(async () => {
			await result.current.start({ projectId: "proj" });
		});
		await act(async () => {
			await result.current.stop();
		});
		await act(async () => {
			await result.current.submitIssue();
		});

		expect(client.createIssue).toHaveBeenCalledOnce();
		const callArg = (client.createIssue as Mock).mock.calls[0][0] as {
			prompt: string;
			promptRef?: string;
			artifactRef?: string;
		};
		// The rendered prompt must ride as `prompt` (the issue body the server reads),
		// never the old promptRef field that the server ignored.
		expect(typeof callArg.prompt).toBe("string");
		expect(callArg.prompt.length).toBeGreaterThan(0);
		expect(callArg.promptRef).toBeUndefined();
		// saveArtifact resolved { dir: "/tmp/cap" } → that ref must reach the API.
		expect(callArg.artifactRef).toBe("/tmp/cap");
	});

	it("(b3) submitIssue publishes the effective (overridden) target to local artifact state", async () => {
		const client = makeFakeClient();
		const { result } = renderHook(() => useSession(client));

		await act(async () => {
			await result.current.start({ projectId: "proj" });
		});
		await act(async () => {
			await result.current.stop();
		});
		// Late override selection at file-time: a different project/branch.
		await act(async () => {
			await result.current.submitIssue({
				projectId: "proj2",
				workspaceId: "ws2",
				branch: "feat/late",
			});
		});

		// Local history must reflect the filed target, not the record-start one.
		expect(result.current.artifact?.projectId).toBe("proj2");
		expect(result.current.artifact?.workspaceId).toBe("ws2");
		expect(result.current.artifact?.branch).toBe("feat/late");
		// The submit-time upload (the last saveArtifact) carries the edited artifact
		// with the overridden target, not the record-start save.
		const calls = (client.saveArtifact as Mock).mock.calls;
		const savedArg = calls[calls.length - 1][0] as {
			artifact: { projectId?: string; branch?: string };
		};
		expect(savedArg.artifact.projectId).toBe("proj2");
		expect(savedArg.artifact.branch).toBe("feat/late");
	});

	it("(b4) a superseded start() resolves false so a chained enableVoice is skipped", async () => {
		const client = makeFakeClient();
		let resolveGrab: (g: typeof mockGrabber) => void = () => {};
		const deferred = new Promise<typeof mockGrabber>((r) => {
			resolveGrab = r;
		});
		// First start awaits a pending grabber; the second start (default resolved
		// grabber) supersedes it before the first resolves.
		(startScreenGrabber as Mock).mockReturnValueOnce(deferred);
		const { result } = renderHook(() => useSession(client, "onClick"));

		let firstStarted: boolean | undefined;
		await act(async () => {
			const p1 = result.current.start({});
			await result.current.start({}); // supersede: generation bumps
			resolveGrab(mockGrabber);
			firstStarted = await p1;
		});

		// The stale start reports cancelled so the caller must not enableVoice.
		expect(firstStarted).toBe(false);
		expect(result.current.phase).toBe("recording");
	});

	it("(c) batch-fallback: transcribeBatch called when mintStreamingToken rejects", async () => {
		const client = makeFakeClient({
			mintStreamingToken: vi.fn().mockRejectedValue(new Error("no token")),
		});
		const { result } = renderHook(() => useSession(client));

		await act(async () => {
			await result.current.start({});
		});
		// mintStreamingToken failed → no transcriber → audio.start({}) → streaming=false
		expect(mockAudioInstance.streaming).toBe(false);

		await act(async () => {
			await result.current.stop();
		});
		expect(result.current.phase).toBe("reviewing");
		expect(client.transcribeBatch).toHaveBeenCalledOnce();
		expect(result.current.transcript).toEqual([
			{ tStartMs: 0, tEndMs: 1000, text: "batch" },
		]);
	});

	it("(d) mic-unavailable: enableVoice rejects → voiceEnabled stays false, phase stays recording", async () => {
		const client = makeFakeClient();
		mockAudioInstance.start = vi
			.fn()
			.mockRejectedValue(new Error("Permission denied"));

		const { result } = renderHook(() => useSession(client));

		await act(async () => {
			await result.current.start({});
		});
		expect(result.current.phase).toBe("recording");

		await act(async () => {
			await result.current.enableVoice();
		});

		// Voice failed but recording continues without mic
		expect(result.current.phase).toBe("recording");
		expect(result.current.voiceEnabled).toBe(false);
	});

	it("(d2) mic-unavailable: transcriber websocket is stopped when audio.start() throws (FIX codex M2)", async () => {
		const client = makeFakeClient();
		// Transcriber starts OK; mic permission is denied.
		mockAudioInstance.start = vi
			.fn()
			.mockRejectedValue(new Error("Permission denied"));

		const { result } = renderHook(() => useSession(client));

		await act(async () => {
			await result.current.start({});
		});
		expect(result.current.phase).toBe("recording");

		await act(async () => {
			await result.current.enableVoice();
		});

		// Voice disabled, recording intact.
		expect(result.current.voiceEnabled).toBe(false);
		expect(result.current.phase).toBe("recording");
		// The transcriber ws that opened before audio.start() threw must be stopped.
		expect(mockTranscriberInstance.stop).toHaveBeenCalled();
	});

	it("(e) save-failure: saveArtifact rejects → degrades to reviewing with a warning (not fatal)", async () => {
		const client = makeFakeClient({
			saveArtifact: vi
				.fn()
				.mockRejectedValue(new Error("413 artifact too large")),
		});
		const { result } = renderHook(() => useSession(client));

		await act(async () => {
			await result.current.start({ projectId: "proj" });
		});
		await act(async () => {
			await result.current.stop();
		});

		// Upload failed, but the capture survives: review is reachable so
		// clipboard/download/File issue still work — not a fatal error.
		expect(result.current.phase).toBe("reviewing");
		expect(result.current.saveWarning).toMatch(/Couldn't upload/);
		expect(result.current.error).toBeUndefined();
		expect(result.current.artifact).toBeDefined();
	});

	it("(f) failing token resolution sets needsKey after enableVoice, phase stays recording", async () => {
		const client = makeFakeClient({
			mintStreamingToken: vi.fn().mockRejectedValue(new Error("no token")),
		});
		const { result } = renderHook(() => useSession(client));

		await act(async () => {
			await result.current.start({});
		});
		expect(result.current.phase).toBe("recording");
		expect(result.current.needsKey).toBe(false);

		await act(async () => {
			await result.current.enableVoice();
		});

		expect(result.current.phase).toBe("recording");
		expect(result.current.needsKey).toBe(true);
		expect(result.current.streaming).toBe(false);
	});

	it("(g) provideKey goes live mid-recording after enableVoice: streaming true, needsKey false", async () => {
		const client = makeFakeClient({
			// First call (enableVoice) rejects → needsKey; second call (provideKey's
			// resolveStreamingToken fall-through) resolves → live transcription.
			mintStreamingToken: vi
				.fn()
				.mockRejectedValueOnce(new Error("no token"))
				.mockResolvedValue({ token: "tok", expiresAt: 0 }),
		});
		// provideKey persists the key onto window; force the v3 mint to fail so
		// resolveStreamingToken falls through to client.mintStreamingToken.
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("no fetch")));
		const { result } = renderHook(() => useSession(client));

		await act(async () => {
			await result.current.start({});
		});
		// needsKey is false after start (no mic requested yet)
		expect(result.current.needsKey).toBe(false);

		// Enable voice → fails token → needsKey
		await act(async () => {
			await result.current.enableVoice();
		});
		expect(result.current.needsKey).toBe(true);

		let ok = false;
		await act(async () => {
			ok = await result.current.provideKey("k");
		});

		expect(ok).toBe(true);
		expect(result.current.streaming).toBe(true);
		expect(result.current.needsKey).toBe(false);
		expect(mockTranscriberInstance.start).toHaveBeenCalled();
		expect(mockAudioInstance.attachLiveTranscription).toHaveBeenCalledOnce();

		vi.unstubAllGlobals();
	});

	it("(h) commits a trailing partial transcript on stop (no end-of-turn)", async () => {
		// jsdom v3-mint path fails → resolveStreamingToken falls back to the client.
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("no fetch")));
		const client = makeFakeClient();
		const { result } = renderHook(() => useSession(client));
		await act(async () => {
			await result.current.start({});
		});
		await act(async () => {
			await result.current.enableVoice();
		});
		// Live path engaged, so the transcriber handlers are wired.
		expect(result.current.streaming).toBe(true);
		// A live partial arrives but the turn never finalizes (Stop pressed
		// mid-utterance ⇒ AssemblyAI sends no end_of_turn=true).
		act(() => {
			mockTranscriberInstance.handlers?.onPartial?.("o botao de salvar trava");
		});
		await act(async () => {
			await result.current.stop();
		});
		expect(result.current.transcript.map((s) => s.text)).toContain(
			"o botao de salvar trava",
		);
		vi.unstubAllGlobals();
	});

	it("(i) keeps live captions on stop and never lets an empty batch overwrite them", async () => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("no fetch")));
		const client = makeFakeClient();
		const { result } = renderHook(() => useSession(client));
		await act(async () => {
			await result.current.start({});
		});
		await act(async () => {
			await result.current.enableVoice();
		});
		// A final turn is captured live during recording.
		act(() => {
			mockTranscriberInstance.handlers?.onFinal?.({
				text: "o salvar nao funciona",
				tStartMs: 0,
				tEndMs: 1500,
			});
		});
		// The socket later errors — the path that previously forced the empty
		// batch fallback to clobber the live transcript.
		mockTranscriberInstance.errored = true;
		await act(async () => {
			await result.current.stop();
		});
		expect(result.current.transcript.map((s) => s.text)).toContain(
			"o salvar nao funciona",
		);
		// With a live transcript present, batch transcription must not run.
		expect(client.transcribeBatch).not.toHaveBeenCalled();
		vi.unstubAllGlobals();
	});

	it("(j) anchors a segment at the turn's first-partial time, not 0:00", async () => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("no fetch")));
		let nowMs = 0;
		const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => nowMs);
		const client = makeFakeClient();
		const { result } = renderHook(() => useSession(client));
		await act(async () => {
			await result.current.start({}); // startPerfRef = 0
		});
		await act(async () => {
			await result.current.enableVoice();
		});
		// 4 s of silence, then the turn's first partial.
		nowMs = 4000;
		act(() => {
			mockTranscriberInstance.handlers?.onPartial?.("Esse daqui");
		});
		// Turn ends at 6 s.
		nowMs = 6000;
		act(() => {
			mockTranscriberInstance.handlers?.onFinal?.({
				text: "Esse daqui",
				tStartMs: 0,
				tEndMs: 999,
			});
		});
		const seg = result.current.transcript[0];
		expect(seg.tStartMs).toBe(4000); // first-partial time, not 0
		expect(seg.tEndMs).toBe(6000);
		nowSpy.mockRestore();
		vi.unstubAllGlobals();
	});
});

// ---------------------------------------------------------------------------
// onClick capture + numbering + ordering
// ---------------------------------------------------------------------------

function pointerClick(el: Element, x = 10, y = 20): void {
	el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
	el.dispatchEvent(
		new MouseEvent("mouseup", { bubbles: true, clientX: x, clientY: y }),
	);
}

describe("useSession — onClick capture", () => {
	afterEach(() => {
		localStorage.clear();
		document.body.innerHTML = "";
		vi.restoreAllMocks();
	});

	it("(f) every page click reserves a numbered snapshot (no throttle)", async () => {
		vi.spyOn(window, "getSelection").mockReturnValue({
			toString: () => "",
		} as Selection);
		const btn = document.createElement("button");
		document.body.appendChild(btn);
		const client = makeFakeClient();
		const { result } = renderHook(() => useSession(client, "onClick"));

		await act(async () => {
			await result.current.start({});
		});
		expect(result.current.phase).toBe("recording");

		await act(async () => {
			pointerClick(btn);
			pointerClick(btn);
			pointerClick(btn);
		});

		// Every click gets its own snapshot slot — no coalescing.
		expect(result.current.markCount).toBe(3);
	});

	it("(g) click inside [data-bugtoprompt] does NOT reserve or grab", async () => {
		vi.spyOn(window, "getSelection").mockReturnValue({
			toString: () => "",
		} as Selection);
		const overlay = document.createElement("div");
		overlay.setAttribute("data-bugtoprompt", "");
		const inner = document.createElement("button");
		overlay.appendChild(inner);
		document.body.appendChild(overlay);
		const client = makeFakeClient();
		const { result } = renderHook(() => useSession(client, "onClick"));

		await act(async () => {
			await result.current.start({});
		});
		await act(async () => {
			pointerClick(inner);
		});

		expect(mockGrabber.grab).not.toHaveBeenCalled();
		expect(result.current.markCount).toBe(0);
	});

	it("(h) clickPreviews populate in click order with 1-based numbers + refs", async () => {
		vi.spyOn(window, "getSelection").mockReturnValue({
			toString: () => "",
		} as Selection);
		mockGrabber.grab.mockResolvedValue({
			blob: new Blob(["img"], { type: "image/jpeg" }),
			method: "getDisplayMedia",
		});
		const btn = document.createElement("button");
		document.body.appendChild(btn);
		const client = makeFakeClient();
		const { result } = renderHook(() => useSession(client, "onClick"));

		await act(async () => {
			await result.current.start({});
		});
		await act(async () => {
			pointerClick(btn);
			pointerClick(btn);
			// Let both grab promises resolve.
			await Promise.resolve();
			await Promise.resolve();
		});

		const previews = result.current.clickPreviews;
		expect(previews.map((p) => p.clickNumber)).toEqual([1, 2]);
		expect(previews[0].screenshotRef).toBe("snap-0000.jpg");
		expect(previews[1].screenshotRef).toBe("snap-0001.jpg");
		expect(previews[0].url).toContain("blob:mock");
		// grab received the point + clickNumber input for each click.
		expect(mockGrabber.grab).toHaveBeenCalledWith({
			point: { x: 10, y: 20 },
			clickNumber: 1,
		});
	});

	it("(i) route change triggers exactly one throttled whole-frame snap", async () => {
		const client = makeFakeClient();
		const { result } = renderHook(() => useSession(client, "onClick"));

		await act(async () => {
			await result.current.start({});
		});
		await act(async () => {
			window.history.pushState({}, "", "/new-route");
		});

		// Route snap goes through mark() (whole-frame, no click input).
		expect(result.current.markCount).toBe(1);
		expect(mockGrabber.grab).toHaveBeenCalledWith();
	});

	it("(j) stop() awaits pending click grabs before assembling the artifact", async () => {
		vi.spyOn(window, "getSelection").mockReturnValue({
			toString: () => "",
		} as Selection);
		const gate = deferred<{
			blob: Blob;
			method: "getDisplayMedia";
		} | null>();
		mockGrabber.grab.mockReturnValueOnce(gate.promise);
		const btn = document.createElement("button");
		document.body.appendChild(btn);
		const client = makeFakeClient();
		const { result } = renderHook(() => useSession(client, "onClick"));

		await act(async () => {
			await result.current.start({});
		});
		await act(async () => {
			pointerClick(btn);
		});

		await act(async () => {
			const stopping = result.current.stop();
			// Resolve the grab only after stop() has begun; stop must wait for it.
			gate.resolve({
				blob: new Blob(["img"], { type: "image/jpeg" }),
				method: "getDisplayMedia",
			});
			await stopping;
		});

		expect(result.current.phase).toBe("reviewing");
		// The late grab's screenshot made it into the assembled snapshot.
		const shot = result.current.artifact?.snapshots.find(
			(s) => s.screenshotRef === "snap-0000.jpg",
		);
		expect(shot).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// Rehydration tests
// ---------------------------------------------------------------------------

describe("useSession — rehydration", () => {
	afterEach(() => {
		localStorage.clear();
	});

	it("(k) clean store → starts idle (no rehydration)", async () => {
		const client = makeFakeClient();
		const { result } = renderHook(() => useSession(client));
		// Allow the rehydrate effect to settle.
		await act(async () => {});
		expect(result.current.phase).toBe("idle");
	});

	it("(l) pre-seeded recording session → rehydrates to recording with markCount + transcript", async () => {
		const sessionId = "cap_rehydrate-test";
		const startedAt = Date.now() - 10_000;

		saveSession({
			v: 1,
			sessionId,
			startedAt,
			binding: { projectId: "proj-1" },
			status: "recording",
			events: [{ tMs: 100, kind: "mark" }],
			snapshots: [
				{
					tMs: 100,
					viewport: { width: 1280, height: 800, scrollX: 0, scrollY: 0 },
					interactiveElements: [],
				},
			],
			transcript: [{ tStartMs: 0, tEndMs: 1000, text: "restored" }],
			durationMs: 5000,
		});
		await putShot(sessionId, 0, new Blob(["png"], { type: "image/png" }));

		const client = makeFakeClient();
		const { result } = renderHook(() => useSession(client));

		// Allow the async rehydrate effect (IDB + audio start) to fully settle.
		await act(async () => {
			await new Promise((r) => setTimeout(r, 50));
		});

		expect(result.current.phase).toBe("recording");
		expect(result.current.markCount).toBe(1);
		expect(result.current.transcript).toEqual([
			{ tStartMs: 0, tEndMs: 1000, text: "restored" },
		]);
		// elapsed is computed from startedAt; 10 s ago → elapsedMs > 0.
		expect(result.current.elapsedMs).toBeGreaterThan(0);
	});

	it("(m) pre-seeded reviewing session → rehydrates to reviewing with artifact", async () => {
		const sessionId = "cap_review-test";

		saveSession({
			v: 1,
			sessionId,
			startedAt: Date.now() - 20_000,
			binding: { projectId: "proj-2" },
			status: "reviewing",
			events: [],
			snapshots: [],
			transcript: [{ tStartMs: 0, tEndMs: 500, text: "reviewed" }],
			durationMs: 20_000,
		});

		const client = makeFakeClient();
		const { result } = renderHook(() => useSession(client));

		await act(async () => {
			await new Promise((r) => setTimeout(r, 20));
		});

		expect(result.current.phase).toBe("reviewing");
		expect(result.current.artifact).toBeDefined();
		expect(result.current.transcript).toEqual([
			{ tStartMs: 0, tEndMs: 500, text: "reviewed" },
		]);
	});

	it("(m2) rehydrates click screenshot previews from persisted clicks + blobs", async () => {
		const sessionId = "cap_preview-rehydrate";
		saveSession({
			v: 1,
			sessionId,
			startedAt: Date.now() - 15_000,
			binding: { projectId: "proj-3" },
			status: "reviewing",
			// Two clicks persisted out of resolution order (2 before 1) to prove
			// the rebuilt strip is sorted by clickNumber, not snapshot order.
			events: [
				{
					tMs: 200,
					kind: "click",
					clickNumber: 2,
					screenshotRef: "snap-0001.jpg",
				},
				{
					tMs: 100,
					kind: "click",
					clickNumber: 1,
					screenshotRef: "snap-0000.jpg",
				},
			],
			snapshots: [
				{
					tMs: 100,
					screenshotRef: "snap-0000.jpg",
					viewport: { width: 1280, height: 800, scrollX: 0, scrollY: 0 },
					interactiveElements: [],
				},
				{
					tMs: 200,
					screenshotRef: "snap-0001.jpg",
					viewport: { width: 1280, height: 800, scrollX: 0, scrollY: 0 },
					interactiveElements: [],
				},
			],
			transcript: [],
			durationMs: 15_000,
		});
		await putShot(sessionId, 0, new Blob(["a"], { type: "image/jpeg" }));
		await putShot(sessionId, 1, new Blob(["b"], { type: "image/jpeg" }));

		const client = makeFakeClient();
		const { result } = renderHook(() => useSession(client));
		await act(async () => {
			await new Promise((r) => setTimeout(r, 30));
		});

		expect(result.current.phase).toBe("reviewing");
		expect(result.current.clickPreviews.map((p) => p.clickNumber)).toEqual([
			1, 2,
		]);
		expect(result.current.clickPreviews[0].screenshotRef).toBe("snap-0000.jpg");
		expect(result.current.clickPreviews[0].url).toMatch(/^blob:/);
	});

	it("(m3) submitIssue after a reviewing rehydrate files the issue (empty pending rehydrated, not a silent no-op)", async () => {
		const sessionId = "cap_review-submit";
		saveSession({
			v: 1,
			sessionId,
			startedAt: Date.now() - 20_000,
			binding: { projectId: "proj-9" },
			status: "reviewing",
			events: [],
			snapshots: [
				{
					tMs: 100,
					screenshotRef: "snap-0000.jpg",
					viewport: { width: 1280, height: 800, scrollX: 0, scrollY: 0 },
					interactiveElements: [],
				},
			],
			transcript: [{ tStartMs: 0, tEndMs: 500, text: "reviewed" }],
			durationMs: 20_000,
		});

		const client = makeFakeClient();
		const { result } = renderHook(() => useSession(client));
		await waitFor(() => expect(result.current.phase).toBe("reviewing"));

		// Before the fix, restoreReviewing never repopulated pendingRef, so this
		// submit hit `if (!base || !pending) return` and silently no-opped:
		// phase stayed "reviewing" and createIssue was never called.
		await act(async () => {
			await result.current.submitIssue();
		});

		expect(client.createIssue).toHaveBeenCalledOnce();
		expect(result.current.phase).toBe("done");
		expect(result.current.issueUrl).toBe("https://gh/1");

		// The rehydrated pending is empty: audio + screenshots were already staged
		// server-side at finalize, so the re-upload only rewrites artifact.json and
		// must not resend media bytes.
		const saveCalls = (client.saveArtifact as Mock).mock.calls;
		const lastSave = saveCalls[saveCalls.length - 1][0] as {
			audioBase64: string;
			screenshotsBase64: string[];
		};
		expect(lastSave.audioBase64).toBe("");
		expect(lastSave.screenshotsBase64).toEqual([]);

		// The artifact-link (saved.dir → artifactRef) still reaches createIssue,
		// so a reload-filed issue stays linked to its stored capture.
		const issueArg = (client.createIssue as Mock).mock.calls[0][0] as {
			artifactRef?: string;
		};
		expect(issueArg.artifactRef).toBe("/tmp/cap");
	});
});

// ---------------------------------------------------------------------------
// screenshotMode + grabber acquisition
// ---------------------------------------------------------------------------

describe("useSession — screenshotMode", () => {
	afterEach(() => {
		localStorage.clear();
		document.body.innerHTML = "";
		vi.restoreAllMocks();
	});

	it("(n) 'off' → no grabber acquired at start; mark() pushes a DOM-only snapshot", async () => {
		const client = makeFakeClient();
		const { result } = renderHook(() => useSession(client, "off"));

		await act(async () => {
			await result.current.start({});
		});
		// "off" never requests screen share.
		expect(startScreenGrabber).not.toHaveBeenCalled();

		await act(async () => {
			await result.current.mark();
		});

		expect(mockGrabber.grab).not.toHaveBeenCalled();
		expect(result.current.markCount).toBe(1);
	});

	it("(n2) 'onClick' acquires the grabber once at start (inside the Start gesture)", async () => {
		const client = makeFakeClient();
		const { result } = renderHook(() => useSession(client, "onClick"));

		await act(async () => {
			await result.current.start({});
		});

		expect(startScreenGrabber).toHaveBeenCalledOnce();
		expect(result.current.phase).toBe("recording");
		expect(result.current.screenshotsUnavailable).toBe(false);
	});

	it("(n3) 'onMark' acquires the grabber so manual Mark captures a whole-frame shot", async () => {
		mockGrabber.grab.mockResolvedValue({
			blob: new Blob(["img"], { type: "image/jpeg" }),
			method: "getDisplayMedia",
		});
		const client = makeFakeClient();
		const { result } = renderHook(() => useSession(client, "onMark"));

		await act(async () => {
			await result.current.start({});
		});
		expect(startScreenGrabber).toHaveBeenCalledOnce();

		await act(async () => {
			await result.current.mark();
		});
		// Whole-frame grab (no click input).
		expect(mockGrabber.grab).toHaveBeenCalledWith();
		expect(result.current.markCount).toBe(1);
	});

	it("(o) denied/unavailable display capture → screenshotsUnavailable, clicks still reserved DOM-only", async () => {
		vi.spyOn(window, "getSelection").mockReturnValue({
			toString: () => "",
		} as Selection);
		(startScreenGrabber as unknown as Mock).mockResolvedValueOnce({
			available: false,
			grab: vi.fn().mockResolvedValue(null),
			stop: vi.fn(),
		});
		const btn = document.createElement("button");
		document.body.appendChild(btn);
		const client = makeFakeClient();
		const { result } = renderHook(() => useSession(client, "onClick"));

		await act(async () => {
			await result.current.start({});
		});
		expect(result.current.screenshotsUnavailable).toBe(true);
		expect(result.current.phase).toBe("recording");

		await act(async () => {
			pointerClick(btn);
		});
		// Click still recorded as a numbered DOM-only snapshot; no preview image.
		expect(result.current.markCount).toBe(1);
		expect(result.current.clickPreviews).toHaveLength(0);
		// …but the click IS counted so the recorder never shows "0 clicks".
		expect(result.current.clickCount).toBe(1);
	});

	it("(p) resumes click numbering from the highest persisted clickNumber", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		vi.spyOn(window, "getSelection").mockReturnValue({
			toString: () => "",
		} as Selection);
		const sessionId = "cap_resume-clicknum";
		saveSession({
			v: 1,
			sessionId,
			startedAt: Date.now() - 5000,
			binding: {},
			status: "recording",
			events: [{ tMs: 100, kind: "click", selector: "#a", clickNumber: 2 }],
			snapshots: [
				{
					tMs: 100,
					viewport: { width: 1280, height: 800, scrollX: 0, scrollY: 0 },
					interactiveElements: [],
				},
			],
			transcript: [],
			durationMs: 5000,
		});
		const btn = document.createElement("button");
		document.body.appendChild(btn);
		const client = makeFakeClient();
		const { result } = renderHook(() => useSession(client, "onClick"));

		await act(async () => {
			await vi.advanceTimersByTimeAsync(60);
		});
		expect(result.current.phase).toBe("recording");

		await act(async () => {
			pointerClick(btn);
			await vi.advanceTimersByTimeAsync(500);
		});

		const saved = loadSession();
		const lastClick = saved?.events.filter((e) => e.kind === "click").at(-1);
		// Next click continues from 2 → 3, never reusing an ordinal.
		expect(lastClick?.clickNumber).toBe(3);
		vi.useRealTimers();
	});

	it("(p2) rehydrated screenshot-enabled recording → screenshotsUnavailable (no grabber on resume)", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		saveSession({
			v: 1,
			sessionId: "cap_resume-noshot",
			startedAt: Date.now() - 5000,
			binding: {},
			status: "recording",
			events: [],
			snapshots: [],
			transcript: [],
			durationMs: 5000,
		});
		const client = makeFakeClient();
		const { result } = renderHook(() => useSession(client, "onClick"));

		await act(async () => {
			await vi.advanceTimersByTimeAsync(60);
		});
		expect(result.current.phase).toBe("recording");
		// Resume never re-acquires the grabber, so screenshots are unavailable.
		expect(result.current.screenshotsUnavailable).toBe(true);
		vi.useRealTimers();
	});
});

// ---------------------------------------------------------------------------
// Persistence-during-recording tests
// ---------------------------------------------------------------------------

describe("useSession — persistence during recording", () => {
	afterEach(() => {
		localStorage.clear();
		vi.useRealTimers();
	});

	it("(o) after start + mark, localStorage holds status 'recording' with event + snapshot counts", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });

		const client = makeFakeClient();
		const { result } = renderHook(() => useSession(client));

		await act(async () => {
			await result.current.start({});
		});

		await act(async () => {
			await result.current.mark();
		});

		// Advance past the 400 ms debounce so saveSession fires.
		await act(async () => {
			vi.advanceTimersByTime(500);
		});

		const saved = loadSession();
		expect(saved).not.toBeNull();
		expect(saved?.status).toBe("recording");
		// mark() pushes one snapshot + one "mark" event.
		expect(saved?.snapshots).toHaveLength(1);
		expect(saved?.events.filter((e) => e.kind === "mark")).toHaveLength(1);
	});

	it("(p) start with zero marks persists the recording session immediately (survives full-page navigation before any event)", async () => {
		const client = makeFakeClient();
		const { result, unmount } = renderHook(() => useSession(client));

		await act(async () => {
			await result.current.start({ projectId: "proj-1" });
		});

		// Prod repro: recording started, no marks, no voice, no clicks — then a
		// full-page (MPA) navigation. The session MUST already be in localStorage
		// so the next page can rehydrate it. No debounce advance: the write is
		// synchronous at record-start, not gated on the first capture event.
		const saved = loadSession();
		expect(saved).not.toBeNull();
		expect(saved?.status).toBe("recording");
		expect(saved?.sessionId).toBeTruthy();

		unmount();
	});

	it("(q) pagehide flushes a still-debounced recording update synchronously", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });

		const client = makeFakeClient();
		const { result } = renderHook(() => useSession(client));

		await act(async () => {
			await result.current.start({});
		});

		// A mark schedules a debounced (400 ms) persist. Before it fires, a
		// full-page navigation dispatches `pagehide`. The mark must still reach
		// storage — the debounce window cannot swallow the last event.
		await act(async () => {
			await result.current.mark();
		});
		act(() => {
			window.dispatchEvent(new Event("pagehide"));
		});

		const saved = loadSession();
		expect(saved?.status).toBe("recording");
		expect(saved?.snapshots).toHaveLength(1);
	});
});
