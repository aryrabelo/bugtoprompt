/**
 * reviewBinding late-projectId fallback.
 *
 * Regression for the cubic finding: when recording starts before the config
 * resolves, the frozen binding has no projectId. If listTargets() then fails or
 * returns empty the user can never pick a reviewTarget — yet filing must become
 * usable the moment the resolved projectId arrives. Pre-fix the file button
 * stayed disabled forever because reviewBinding was gated on a picked target.
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
import { BugToPrompt } from "./BugToPrompt";

// ---------------------------------------------------------------------------
// Mocks (mirror modes.test.tsx — keep capture machinery inert)
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

beforeEach(() => {
	vi.clearAllMocks();
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

afterEach(cleanup);

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe("BugToPrompt reviewBinding late-projectId fallback", () => {
	it("enables Create GitHub issue once projectId resolves after a target-less frozen start", async () => {
		const client = makeFakeClient();

		// Start recording BEFORE projectId is known — frozen binding has no
		// projectId (config resolved after record-start).
		const { rerender } = render(
			<BugToPrompt client={client} projectId={undefined} modes={["issue"]} />,
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

		// projectId resolves now, in the reviewing phase, with NO reviewTarget
		// picked (listTargets returned empty).
		rerender(
			<BugToPrompt client={client} projectId="proj-late" modes={["issue"]} />,
		);

		// Filing is usable immediately from the resolved projectId — pre-fix this
		// stayed disabled forever because reviewBinding required a picked target.
		const fileBtn = screen.getByTestId("create-issue") as HTMLButtonElement;
		expect(fileBtn.disabled).toBe(false);
	});
});
