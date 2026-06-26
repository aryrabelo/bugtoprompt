/**
 * History panel tests:
 * - Idle panel lists seeded CaptureRecords.
 * - Per-item Copy calls the injected clipboard.writeText with the record prompt.
 * - Per-item Delete removes the row and shrinks the list.
 * - Finishing a clipboard capture appends a record to listCaptures().
 */
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import type { Mock } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BugToPromptClient, Target } from "../client";
import type { CaptureArtifact } from "../schema";
import { BugToPrompt } from "./BugToPrompt";
import type { CaptureRecord, OutputMode } from "./session-store";
import { addCapture, listCaptures } from "./session-store";

// ---------------------------------------------------------------------------
// Mocks — same pattern as modes.test.tsx
// ---------------------------------------------------------------------------

let mockAudioInstance: {
	streaming: boolean;
	start: Mock;
	stop: Mock;
};

const mockGrabber = vi.hoisted(() => ({
	grab: vi.fn().mockResolvedValue(null),
	stop: vi.fn(),
}));

vi.mock("./audio/AudioCapture", () => ({
	AudioCapture: vi.fn().mockImplementation(() => mockAudioInstance),
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
	renderPrompt: vi.fn().mockReturnValue("# Rendered prompt content"),
	promptTitle: vi.fn().mockReturnValue("Test capture title"),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeArtifact(sessionId: string): CaptureArtifact {
	return {
		version: 1,
		sessionId,
		pageUrl: `https://example.com/${sessionId}`,
		userAgent: "test-agent",
		startedAt: 0,
		durationMs: 1000,
		audio: { ref: "audio-ref", mimeType: "audio/webm", bytes: 0 },
		transcript: [],
		events: [],
		snapshots: [],
		transcriptionMode: "streaming",
	};
}

function makeRecord(id: string, title: string, prompt: string): CaptureRecord {
	return {
		v: 1,
		id,
		title,
		createdAt: Date.now(),
		pageUrl: `https://example.com/${id}`,
		prompt,
		artifact: makeArtifact(id),
		mode: "clipboard" as OutputMode,
	};
}

function makeFakeClient(): BugToPromptClient {
	return {
		mintStreamingToken: vi
			.fn()
			.mockResolvedValue({ token: "tok", expiresAt: 0 }),
		saveArtifact: vi
			.fn()
			.mockResolvedValue({ dir: "/tmp/cap", sessionId: "s1" }),
		transcribeBatch: vi.fn().mockResolvedValue({ transcript: [] }),
		createIssue: vi
			.fn()
			.mockResolvedValue({ created: true, number: 1, url: "https://gh/1" }),
		listTargets: vi.fn().mockResolvedValue([] as Target[]),
	};
}

/**
 * Drive the overlay to the reviewing phase, then click the Copy button.
 * Returns the fakeClient for assertion.
 */
async function driveToClipboardFinish(clipboardWriteText: Mock): Promise<void> {
	const client = makeFakeClient();
	render(
		<BugToPrompt
			client={client}
			projectId="proj-test"
			modes={["clipboard"]}
			clipboard={{ writeText: clipboardWriteText }}
		/>,
	);

	fireEvent.click(screen.getByRole("button", { name: /bugtoprompt/i }));

	await act(async () => {
		fireEvent.click(screen.getByRole("button", { name: /record/i }));
	});
	await act(async () => {
		fireEvent.click(screen.getByRole("button", { name: /stop/i }));
	});

	await waitFor(() =>
		expect(screen.queryByRole("button", { name: /copy/i })).not.toBeNull(),
	);

	await act(async () => {
		fireEvent.click(screen.getByRole("button", { name: /copy/i }));
	});
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
	vi.clearAllMocks();
	localStorage.clear();

	mockAudioInstance = {
		streaming: false,
		start: vi
			.fn()
			.mockImplementation(async (handlers: { onPcmFrame?: unknown } = {}) => {
				mockAudioInstance.streaming = !!handlers.onPcmFrame;
			}),
		stop: vi.fn().mockResolvedValue({
			blob: new Blob(["audio"]),
			mimeType: "audio/webm",
			bytes: 5,
		}),
	};

	mockGrabber.grab.mockResolvedValue(null);
	mockGrabber.stop.mockReset();
});

afterEach(() => {
	cleanup();
	localStorage.clear();
});

// ---------------------------------------------------------------------------
// History panel rendering
// ---------------------------------------------------------------------------

describe("BugToPrompt history panel", () => {
	it("shows 'No captures yet.' when history is empty", () => {
		render(
			<BugToPrompt
				client={makeFakeClient()}
				modes={["clipboard"]}
				clipboard={{ writeText: vi.fn() }}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: /bugtoprompt/i }));
		expect(screen.getByText(/no captures yet/i)).toBeTruthy();
	});

	it("renders seeded capture titles in the idle panel", () => {
		addCapture(makeRecord("r1", "First bug capture", "# First"));
		addCapture(makeRecord("r2", "Second bug capture", "# Second"));

		render(
			<BugToPrompt
				client={makeFakeClient()}
				modes={["clipboard"]}
				clipboard={{ writeText: vi.fn() }}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: /bugtoprompt/i }));

		expect(screen.getByText("First bug capture")).toBeTruthy();
		expect(screen.getByText("Second bug capture")).toBeTruthy();
	});

	it("clicking Copy on a history item calls clipboard.writeText with that record's prompt", async () => {
		addCapture(makeRecord("r1", "Alpha", "prompt-alpha"));
		addCapture(makeRecord("r2", "Beta", "prompt-beta"));

		const clipboardWriteText = vi.fn().mockResolvedValue(undefined);
		render(
			<BugToPrompt
				client={makeFakeClient()}
				modes={["clipboard"]}
				clipboard={{ writeText: clipboardWriteText }}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: /bugtoprompt/i }));

		// There are now 2 Copy buttons (one per history item) in the idle panel.
		const copyBtns = screen.getAllByRole("button", { name: /copy/i });
		// Newest is first — r2 (Beta) is at index 0.
		await act(async () => {
			fireEvent.click(copyBtns[0]);
		});

		await waitFor(() =>
			expect(clipboardWriteText).toHaveBeenCalledWith("prompt-beta"),
		);
	});

	it("clicking Delete removes the item from the rendered list", async () => {
		addCapture(makeRecord("del-me", "To delete", "# del"));
		addCapture(makeRecord("keep-me", "To keep", "# keep"));

		render(
			<BugToPrompt
				client={makeFakeClient()}
				modes={["clipboard"]}
				clipboard={{ writeText: vi.fn() }}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: /bugtoprompt/i }));

		expect(screen.getByText("To delete")).toBeTruthy();
		expect(screen.getByText("To keep")).toBeTruthy();

		// Click Delete on the first item (newest = "keep-me"), then on "del-me".
		// Actually: newest is "keep-me" (added last), so Delete[0] removes "keep-me".
		// We want to delete "del-me": get all Delete buttons and click the second one.
		const deleteBtns = screen.getAllByRole("button", { name: /delete/i });
		expect(deleteBtns).toHaveLength(2);

		await act(async () => {
			fireEvent.click(deleteBtns[1]); // index 1 = "del-me" (older)
		});

		await waitFor(() => expect(screen.queryByText("To delete")).toBeNull());
		expect(screen.getByText("To keep")).toBeTruthy();
	});
});

// ---------------------------------------------------------------------------
// Finish → history record
// ---------------------------------------------------------------------------

describe("clipboard finish appends to history", () => {
	it("after clipboard copy, listCaptures() contains one record with mode clipboard", async () => {
		const clipboardWriteText = vi.fn().mockResolvedValue(undefined);
		await driveToClipboardFinish(clipboardWriteText);

		const captured = listCaptures();
		expect(captured).toHaveLength(1);
		expect(captured[0].mode).toBe("clipboard");
	});

	it("the history record's prompt matches what was written to clipboard", async () => {
		const clipboardWriteText = vi.fn().mockResolvedValue(undefined);
		await driveToClipboardFinish(clipboardWriteText);

		const [call] = clipboardWriteText.mock.calls as [[string]];
		const record = listCaptures()[0];
		// Both come from the mocked renderPrompt which returns "# Rendered prompt content".
		expect(call[0]).toBe("# Rendered prompt content");
		expect(record.prompt).toBe("# Rendered prompt content");
	});
});

// ---------------------------------------------------------------------------
// History panel clipboard error surface (P0-1)
// ---------------------------------------------------------------------------

describe("history panel clipboard error", () => {
	it("shows inline alert on the item when copy fails", async () => {
		addCapture(makeRecord("e1", "Error target", "prompt-error"));

		const clipboardWriteText = vi
			.fn()
			.mockRejectedValue(new Error("not allowed"));

		render(
			<BugToPrompt
				client={makeFakeClient()}
				modes={["clipboard"]}
				clipboard={{ writeText: clipboardWriteText }}
			/>,
		);

		// Open the panel (idle phase shows history list).
		fireEvent.click(screen.getByRole("button", { name: /bugtoprompt/i }));

		// The history item Copy button.
		const [copyBtn] = screen.getAllByRole("button", { name: /copy/i });
		await act(async () => {
			fireEvent.click(copyBtn);
		});

		// An inline role="alert" must appear in the item.
		await waitFor(() => expect(screen.queryByRole("alert")).not.toBeNull());
		expect(screen.getByRole("alert").textContent).toMatch(/copy failed/i);
	});
});
