import { act, renderHook } from "@testing-library/react";
import type { Mock } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SnapPromptClient, Target } from "../client";
import { loadSession, putShot, saveSession } from "./session-store";
import { useSession } from "./useSession";

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
}

let mockAudioInstance: MockAudioInstance;
let mockTranscriberInstance: MockTranscriberInstance;

// vi.hoisted ensures this object exists before the vi.mock factories run
const mockGrabber = vi.hoisted(() => ({
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
}));

// ---------------------------------------------------------------------------
// Fake SnapPromptClient
// ---------------------------------------------------------------------------

function makeFakeClient(
	overrides: Partial<SnapPromptClient> = {},
): SnapPromptClient {
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
	delete window.__SNAP_PROMPT__;

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
		start: vi.fn().mockResolvedValue(undefined),
		stop: vi.fn(),
		sendFrame: vi.fn(),
	};

	mockGrabber.grab.mockResolvedValue(null);
	mockGrabber.stop.mockReset();
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

	it("(b2) submitIssue passes prompt to createIssue", async () => {
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
		};
		expect(typeof callArg.prompt).toBe("string");
		expect(callArg.prompt.length).toBeGreaterThan(0);
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

	it("(d) mic-unavailable: AudioCapture.start rejects → phase error", async () => {
		const client = makeFakeClient();
		mockAudioInstance.start = vi
			.fn()
			.mockRejectedValue(new Error("Permission denied"));

		const { result } = renderHook(() => useSession(client));

		await act(async () => {
			await result.current.start({});
		});

		expect(result.current.phase).toBe("error");
		expect(result.current.error).toMatch(/Microphone unavailable/);
	});

	it("(e) save-failure: saveArtifact rejects → phase error", async () => {
		const client = makeFakeClient({
			saveArtifact: vi.fn().mockRejectedValue(new Error("disk full")),
		});
		const { result } = renderHook(() => useSession(client));

		await act(async () => {
			await result.current.start({ projectId: "proj" });
		});
		await act(async () => {
			await result.current.stop();
		});

		expect(result.current.phase).toBe("error");
		expect(result.current.error).toMatch(/Failed to save/);
	});

	it("(f) failing token resolution sets needsKey while phase stays recording", async () => {
		const client = makeFakeClient({
			mintStreamingToken: vi.fn().mockRejectedValue(new Error("no token")),
		});
		const { result } = renderHook(() => useSession(client));

		await act(async () => {
			await result.current.start({});
		});

		expect(result.current.phase).toBe("recording");
		expect(result.current.needsKey).toBe(true);
		expect(result.current.streaming).toBe(false);
	});

	it("(g) provideKey goes live mid-recording: streaming true, needsKey false", async () => {
		const client = makeFakeClient({
			// First call (start) rejects → needsKey; second call (provideKey's
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
});

// ---------------------------------------------------------------------------
// Snap-on-click + ordering tests
// ---------------------------------------------------------------------------

describe("useSession — snap-on-click", () => {
	it("(f) N rapid clicks while recording with snapOnClick ON → snapshot count == 1 within window", async () => {
		const client = makeFakeClient();
		const { result } = renderHook(() => useSession(client));

		await act(async () => {
			await result.current.start({});
		});

		expect(result.current.phase).toBe("recording");
		// Default is ON.
		expect(result.current.snapOnClick).toBe(true);

		// Five rapid clicks outside the overlay.
		await act(async () => {
			for (let i = 0; i < 5; i++) {
				document.dispatchEvent(
					new MouseEvent("click", { bubbles: true, cancelable: true }),
				);
			}
		});

		// The 600 ms throttle coalesces the burst into a single leading-edge snap.
		expect(result.current.markCount).toBe(1);
	});

	it("(g) click inside [data-snap-prompt] does NOT snap", async () => {
		const client = makeFakeClient();
		const { result } = renderHook(() => useSession(client));

		await act(async () => {
			await result.current.start({});
		});

		// Build a minimal overlay DOM element with an inner button.
		const overlay = document.createElement("div");
		overlay.setAttribute("data-snap-prompt", "");
		const inner = document.createElement("button");
		overlay.appendChild(inner);
		document.body.appendChild(overlay);

		try {
			await act(async () => {
				inner.dispatchEvent(
					new MouseEvent("click", { bubbles: true, cancelable: true }),
				);
			});

			expect(mockGrabber.grab).not.toHaveBeenCalled();
			expect(result.current.markCount).toBe(0);
		} finally {
			document.body.removeChild(overlay);
		}
	});

	it("(h) ORDERING: flashTick increments strictly after grab() resolves", async () => {
		const client = makeFakeClient();
		const { result } = renderHook(() => useSession(client));

		// grab logs its resolution before returning.
		const grabOrder: string[] = [];
		mockGrabber.grab.mockImplementationOnce(async () => {
			grabOrder.push("grab-resolved");
			return null;
		});

		await act(async () => {
			await result.current.start({});
		});

		const tickBefore = result.current.flashTick;

		await act(async () => {
			await result.current.mark();
		});

		// grab ran (and logged) before mark() returned.
		expect(grabOrder).toEqual(["grab-resolved"]);
		// flashTick incremented exactly once: proves the signal fired after grab.
		expect(result.current.flashTick).toBe(tickBefore + 1);
		// grab was called exactly once.
		expect(mockGrabber.grab).toHaveBeenCalledTimes(1);
	});

	it("(i) route event while recording triggers exactly one throttled snap", async () => {
		const client = makeFakeClient();
		const { result } = renderHook(() => useSession(client));

		await act(async () => {
			await result.current.start({});
		});

		expect(result.current.phase).toBe("recording");

		// Simulate a SPA route change via pushState (eventTrack patches this).
		await act(async () => {
			window.history.pushState({}, "", "/new-route");
		});

		// One snap should have been triggered by the route event.
		expect(result.current.markCount).toBe(1);
	});

	it("(j) route-snap is always on — not gated by snapOnClick toggle", async () => {
		const client = makeFakeClient();
		const { result } = renderHook(() => useSession(client));

		await act(async () => {
			await result.current.start({});
		});

		// Turn OFF snap-on-click.
		act(() => {
			result.current.setSnapOnClick(false);
		});

		expect(result.current.snapOnClick).toBe(false);

		// Route change — must still snap even with snapOnClick=false.
		await act(async () => {
			window.history.pushState({}, "", "/another-route");
		});

		expect(result.current.markCount).toBe(1);
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
});

// ---------------------------------------------------------------------------
// screenshotMode tests
// ---------------------------------------------------------------------------

describe("useSession — screenshotMode", () => {
	afterEach(() => {
		localStorage.clear();
	});

	it("(n) screenshotMode 'off' → mark() skips the screen grabber but still pushes a DOM snapshot", async () => {
		const client = makeFakeClient();
		const { result } = renderHook(() => useSession(client, "off"));

		await act(async () => {
			await result.current.start({});
		});

		await act(async () => {
			await result.current.mark();
		});

		// The grabber mock must never have been called.
		expect(mockGrabber.grab).not.toHaveBeenCalled();
		// A DOM snapshot was still pushed — markCount reflects it.
		expect(result.current.markCount).toBe(1);
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
});
