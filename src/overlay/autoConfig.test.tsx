/**
 * Tests for the auto-configuration resolver:
 * - resolveBaseUrl priority chain
 * - fetchServerConfig ok / error paths
 * - createLocalFallbackClient contract (saveArtifact never throws, etc.)
 * - <BugToPrompt /> zero-config: FAB renders and session reaches reviewing without error
 * - <BugToPrompt /> with config fetch: modes updated after effect
 */
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CaptureArtifact } from "../schema";
import {
	createLocalFallbackClient,
	fetchServerConfig,
	resolveBaseUrl,
} from "./autoConfig";
import { BugToPrompt } from "./BugToPrompt";

// ---------------------------------------------------------------------------
// Shared audio / grabber mocks (same setup as modes.test.tsx)
// ---------------------------------------------------------------------------

const mockGrabber = vi.hoisted(() => ({
	grab: vi.fn().mockResolvedValue(null),
	stop: vi.fn(),
}));

let mockAudioStop: ReturnType<typeof vi.fn>;

vi.mock("./audio/AudioCapture", () => ({
	AudioCapture: vi.fn().mockImplementation(() => ({
		streaming: false,
		start: vi.fn().mockResolvedValue(undefined),
		get stop() {
			return mockAudioStop;
		},
		sampleRate: vi.fn().mockReturnValue(16000),
	})),
}));

vi.mock("./audio/StreamingTranscriber", () => ({
	StreamingTranscriber: vi.fn().mockImplementation(() => ({
		errored: false,
		start: vi.fn().mockResolvedValue(undefined),
		stop: vi.fn(),
		sendFrame: vi.fn(),
	})),
}));

vi.mock("./snapshot/screenshot", () => ({
	startScreenGrabber: vi.fn().mockResolvedValue(mockGrabber),
}));

vi.mock("../render", () => ({
	renderPrompt: vi.fn().mockReturnValue("## mocked prompt"),
	promptTitle: vi.fn().mockReturnValue("Test capture title"),
	transcriptText: vi.fn().mockReturnValue(""),
}));

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
	vi.clearAllMocks();
	mockAudioStop = vi.fn().mockResolvedValue({
		blob: new Blob([]),
		mimeType: "audio/webm",
		bytes: 0,
	});
	mockGrabber.grab.mockResolvedValue(null);
	mockGrabber.stop.mockReset();
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	// Remove any meta tags added during tests.
	for (const el of document.querySelectorAll('meta[name="bugtoprompt-base"]')) {
		el.remove();
	}
	// Remove window global if set.
	delete (window as Window & { __BUGTOPROMPT__?: unknown }).__BUGTOPROMPT__;
});

// ---------------------------------------------------------------------------
// resolveBaseUrl
// ---------------------------------------------------------------------------

describe("resolveBaseUrl", () => {
	it("returns the explicit argument when provided", () => {
		expect(resolveBaseUrl("https://explicit.host")).toBe(
			"https://explicit.host",
		);
	});

	it("window.__BUGTOPROMPT__.baseUrl wins over meta and default", () => {
		(
			window as Window & {
				__BUGTOPROMPT__?: { baseUrl?: string };
			}
		).__BUGTOPROMPT__ = { baseUrl: "https://from-window" };
		expect(resolveBaseUrl()).toBe("https://from-window");
	});

	it("meta tag content used when window global is absent", () => {
		const meta = document.createElement("meta");
		meta.setAttribute("name", "bugtoprompt-base");
		meta.setAttribute("content", "https://from-meta");
		document.head.appendChild(meta);
		expect(resolveBaseUrl()).toBe("https://from-meta");
	});

	it('returns "" when nothing is configured', () => {
		expect(resolveBaseUrl()).toBe("");
	});

	it("explicit arg wins over window global", () => {
		(
			window as Window & {
				__BUGTOPROMPT__?: { baseUrl?: string };
			}
		).__BUGTOPROMPT__ = { baseUrl: "https://from-window" };
		expect(resolveBaseUrl("https://explicit")).toBe("https://explicit");
	});
});

// ---------------------------------------------------------------------------
// fetchServerConfig
// ---------------------------------------------------------------------------

describe("fetchServerConfig", () => {
	it("returns parsed JSON when response is ok", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ modes: ["clipboard"], projectId: "p1" }),
			}),
		);
		const cfg = await fetchServerConfig("https://api");
		expect(cfg).toEqual({ modes: ["clipboard"], projectId: "p1" });
		expect(vi.mocked(fetch)).toHaveBeenCalledWith(
			"https://api/bugtoprompt/config",
		);
	});

	it("returns null when response is not ok", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({ ok: false, status: 404 }),
		);
		expect(await fetchServerConfig("https://api")).toBeNull();
	});

	it("returns null on network error (never throws)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockRejectedValue(new Error("net::ERR_CONNECTION_REFUSED")),
		);
		await expect(fetchServerConfig("https://api")).resolves.toBeNull();
	});

	it("appends /bugtoprompt/config to base even when base is empty", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({ ok: false, status: 404 }),
		);
		await fetchServerConfig("");
		expect(vi.mocked(fetch)).toHaveBeenCalledWith("/bugtoprompt/config");
	});
});

// ---------------------------------------------------------------------------
// createLocalFallbackClient
// ---------------------------------------------------------------------------

describe("createLocalFallbackClient", () => {
	it("saveArtifact resolves with the artifact sessionId (never throws)", async () => {
		const client = createLocalFallbackClient();
		// Cast via unknown — only `sessionId` is accessed by the fallback.
		const artifact = { sessionId: "test-sid" } as unknown as CaptureArtifact;
		await expect(
			client.saveArtifact({ artifact, audioBase64: "", screenshotsBase64: [] }),
		).resolves.toEqual({ dir: "", sessionId: "test-sid" });
	});

	it("transcribeBatch resolves with an empty transcript", async () => {
		const client = createLocalFallbackClient();
		await expect(client.transcribeBatch("sid")).resolves.toEqual({
			transcript: [],
		});
	});

	it("createIssue rejects with a helpful message", async () => {
		const client = createLocalFallbackClient();
		await expect(
			client.createIssue({ sessionId: "s", prompt: "x" }),
		).rejects.toThrow("issue mode requires a backend");
	});

	it("listTargets resolves with an empty array", async () => {
		const client = createLocalFallbackClient();
		await expect(client.listTargets("proj")).resolves.toEqual([]);
	});

	it("mintStreamingToken rejects (triggers batch-fallback path in useSession)", async () => {
		const client = createLocalFallbackClient();
		await expect(client.mintStreamingToken()).rejects.toThrow();
	});
});

// ---------------------------------------------------------------------------
// <BugToPrompt /> zero-config: no props
// ---------------------------------------------------------------------------

describe("<BugToPrompt /> zero-config (no props)", () => {
	it("renders the FAB button when no props are passed", () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockRejectedValue(new Error("no backend configured")),
		);
		render(<BugToPrompt />);
		expect(screen.getByRole("button", { name: /bugtoprompt/i })).toBeTruthy();
	});

	it("reaches reviewing phase via fallback client (saveArtifact resolves)", async () => {
		// fetch always fails → keeps fallback client; saveArtifact resolves so
		// the session completes without error.
		vi.stubGlobal(
			"fetch",
			vi.fn().mockRejectedValue(new Error("no backend configured")),
		);

		render(
			<BugToPrompt
				clipboard={{ writeText: vi.fn().mockResolvedValue(undefined) }}
			/>,
		);

		// Open overlay.
		fireEvent.click(screen.getByRole("button", { name: /bugtoprompt/i }));

		// Start recording.
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: /start capture/i }));
		});

		// Stop recording → triggers saveArtifact on the fallback client.
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: /stop/i }));
		});

		// Should reach reviewing (not error) because saveArtifact resolves.
		await waitFor(() =>
			expect(screen.queryByRole("button", { name: /discard/i })).not.toBeNull(),
		);

		// Clipboard and download actions visible (default zero-config modes).
		expect(screen.queryByRole("button", { name: /copy/i })).not.toBeNull();
		expect(screen.queryByRole("button", { name: /download/i })).not.toBeNull();
	});
});

// ---------------------------------------------------------------------------
// <BugToPrompt /> zero-config: config fetch succeeds → modes upgraded
// ---------------------------------------------------------------------------

describe("<BugToPrompt /> auto-config from server", () => {
	it("upgrades modes after effect resolves server config", async () => {
		// URL-aware mock: only /bugtoprompt/config and /artifact return valid JSON.
		// All other endpoints (/streaming-token, /transcribe) reject so the session
		// degrades gracefully to the batch path without crashing CaptionEditor.
		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation((url: unknown) => {
				if (typeof url === "string" && url.endsWith("/bugtoprompt/config")) {
					return Promise.resolve({
						ok: true,
						json: () =>
							Promise.resolve({
								modes: ["issue", "clipboard"],
								projectId: "p-srv",
							}),
					});
				}
				if (typeof url === "string" && url.endsWith("/artifact")) {
					return Promise.resolve({
						ok: true,
						json: () => Promise.resolve({ dir: "", sessionId: "s1" }),
					});
				}
				// /streaming-token → reject (live=false, batch path)
				// /transcribe → reject (caught; transcript stays [])
				return Promise.reject(new Error("no backend for this endpoint"));
			}),
		);

		render(
			<BugToPrompt
				clipboard={{ writeText: vi.fn().mockResolvedValue(undefined) }}
			/>,
		);

		// Open overlay and drive to reviewing.
		fireEvent.click(screen.getByRole("button", { name: /bugtoprompt/i }));

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: /start capture/i }));
		});
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: /stop/i }));
		});

		await waitFor(() =>
			expect(screen.queryByRole("button", { name: /discard/i })).not.toBeNull(),
		);

		// After config fetch the "issue" mode button must be present (even
		// without projectId the button renders, just disabled).
		expect(
			screen.queryByRole("button", { name: /create github issue/i }),
		).not.toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Explicit client prop: existing contract unchanged
// ---------------------------------------------------------------------------

describe("<BugToPrompt client={...} /> existing contract", () => {
	it("drives to reviewing and shows File Issue with explicit client (default modes)", async () => {
		// createLocalFallbackClient: saveArtifact resolves, transcribeBatch resolves
		// with [], so the session reaches reviewing without error.
		const client = createLocalFallbackClient();
		render(
			<BugToPrompt
				client={client}
				clipboard={{ writeText: vi.fn().mockResolvedValue(undefined) }}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: /bugtoprompt/i }));

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: /start capture/i }));
		});
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: /stop/i }));
		});

		await waitFor(() =>
			expect(screen.queryByRole("button", { name: /discard/i })).not.toBeNull(),
		);

		// Default modes when client is explicit = ['issue'] → File Issue button visible.
		expect(
			screen.queryByRole("button", { name: /create github issue/i }),
		).not.toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Explicit baseUrl is proof of a backend even when the /bugtoprompt/config
// probe fails (404/network) — issue mode + token minting still adopted.
// ---------------------------------------------------------------------------

describe("<BugToPrompt baseUrl /> adopts backend without a config probe", () => {
	it("shows File Issue when baseUrl is set but /bugtoprompt/config 404s", async () => {
		// /bugtoprompt/config → 404 (probe fails); /artifact → ok so the session
		// reaches reviewing; everything else rejects (batch fallback).
		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation((url: unknown) => {
				if (typeof url === "string" && url.endsWith("/bugtoprompt/config")) {
					return Promise.resolve({ ok: false, status: 404 });
				}
				if (typeof url === "string" && url.endsWith("/artifact")) {
					return Promise.resolve({
						ok: true,
						json: () => Promise.resolve({ dir: "", sessionId: "s1" }),
					});
				}
				return Promise.reject(new Error("no backend for this endpoint"));
			}),
		);

		render(
			<BugToPrompt
				baseUrl="/api/bugtoprompt"
				clipboard={{ writeText: vi.fn().mockResolvedValue(undefined) }}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: /bugtoprompt/i }));

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: /start capture/i }));
		});
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: /stop/i }));
		});

		await waitFor(() =>
			expect(screen.queryByRole("button", { name: /discard/i })).not.toBeNull(),
		);

		// Backend adopted from the explicit baseUrl → issue mode present even
		// though the config probe 404'd (old behavior left it clipboard-only).
		expect(
			screen.queryByRole("button", { name: /create github issue/i }),
		).not.toBeNull();
	});
});

// ---------------------------------------------------------------------------
// P0-2: reviewing dead-end. The binding freezes at record-start; if config
// (hence projectId) resolves AFTER that, the frozen binding has no projectId
// so "File issue" used to stay stuck disabled until a target was picked —
// which dead-ended forever when listTargets() failed/returned empty (cubic
// finding, issue #21). Reviewing must unlock filing as soon as the resolved
// projectId is available; the target picker still lets a target be selected
// to narrow/scope the filed issue, but is no longer required to unlock it.
// ---------------------------------------------------------------------------

describe("<BugToPrompt /> reviewing late target binding (P0-2)", () => {
	it("enables File issue as soon as projectId resolves, and still offers a picker to narrow the target", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation((url: unknown) => {
				if (typeof url === "string" && url.endsWith("/bugtoprompt/config")) {
					return Promise.resolve({
						ok: true,
						json: () =>
							Promise.resolve({
								modes: ["issue", "clipboard"],
								projectId: "p-srv",
							}),
					});
				}
				if (typeof url === "string" && url.includes("/targets?projectId=")) {
					return Promise.resolve({
						ok: true,
						json: () =>
							Promise.resolve([{ id: "t1", name: "Repo One", branch: "main" }]),
					});
				}
				if (typeof url === "string" && url.endsWith("/artifact")) {
					return Promise.resolve({
						ok: true,
						json: () => Promise.resolve({ dir: "", sessionId: "s1" }),
					});
				}
				if (typeof url === "string" && url.endsWith("/issue")) {
					return Promise.resolve({
						ok: true,
						json: () =>
							Promise.resolve({
								created: true,
								number: 7,
								url: "https://gh/7",
							}),
					});
				}
				// /streaming-token, /transcribe → reject (batch fallback path).
				return Promise.reject(new Error("no backend for this endpoint"));
			}),
		);

		// Zero-config (no projectId prop): projectId only arrives via the async
		// server-config probe, i.e. AFTER the record-start freeze.
		render(
			<BugToPrompt
				clipboard={{ writeText: vi.fn().mockResolvedValue(undefined) }}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: /bugtoprompt/i }));
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: /start capture/i }));
		});
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: /stop/i }));
		});

		await waitFor(() =>
			expect(screen.queryByRole("button", { name: /discard/i })).not.toBeNull(),
		);

		// Frozen binding has no projectId, but the resolved projectId ("p-srv")
		// unlocks filing immediately — no target pick required (the fix for the
		// cubic dead-end finding: an empty/failed target list must not block
		// filing forever).
		const fileButton = screen.getByRole("button", {
			name: /create github issue/i,
		}) as HTMLButtonElement;
		expect(fileButton.disabled).toBe(false);

		// The reviewing picker is offered and lists the configured target.
		const combobox = screen.getByRole("combobox");
		fireEvent.focus(combobox);
		await waitFor(() =>
			expect(screen.getAllByRole("option").length).toBeGreaterThan(0),
		);

		// Selecting the highlighted target (index 0) late-binds it.
		await act(async () => {
			fireEvent.keyDown(combobox, { key: "Enter" });
		});

		// Still enabled after narrowing to a specific target.
		expect(fileButton.disabled).toBe(false);

		// Filing now works: submitIssue must use the late-bound target, not the
		// empty frozen binding (which would fail with "No project selected").
		await act(async () => {
			fireEvent.click(
				screen.getByRole("button", { name: /create github issue/i }),
			);
		});
		await waitFor(() =>
			expect(screen.queryByText(/issue filed/i)).not.toBeNull(),
		);
	});
});
