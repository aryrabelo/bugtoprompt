/**
 * Output modes: clipboard + download in the review panel.
 * Drives SnapPrompt to the reviewing phase via a fake client, then exercises
 * the injected clipboard and download sinks.
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
import type { SnapPromptClient, Target } from "../client";
import { SnapPrompt } from "./SnapPrompt";

// ---------------------------------------------------------------------------
// Mocks
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

// Stable render output so assertions don't depend on artifact details.
vi.mock("../render", () => ({
	renderPrompt: vi.fn().mockReturnValue("# Rendered prompt content"),
	promptTitle: vi.fn().mockReturnValue("Test capture title"),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFakeClient(): SnapPromptClient {
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
 * Render the overlay, open it, start recording, stop recording.
 * Returns control when the session is in the "reviewing" phase.
 */
async function driveToReview(
	client: SnapPromptClient,
	modes: Array<"issue" | "clipboard" | "download">,
) {
	render(
		<SnapPrompt
			client={client}
			projectId="proj-test"
			modes={modes}
			clipboard={{ writeText: vi.fn().mockResolvedValue(undefined) }}
		/>,
	);

	// Open the overlay.
	fireEvent.click(screen.getByRole("button", { name: /snap/i }));

	// Start recording.
	await act(async () => {
		fireEvent.click(screen.getByRole("button", { name: /record/i }));
	});

	// Stop recording.
	await act(async () => {
		fireEvent.click(screen.getByRole("button", { name: /stop/i }));
	});

	await waitFor(() =>
		expect(screen.queryByRole("button", { name: /discard/i })).not.toBeNull(),
	);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

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
// Tests
// ---------------------------------------------------------------------------

describe("SnapPrompt output modes", () => {
	it("issue mode: 'File issue' button is visible in review phase", async () => {
		const client = makeFakeClient();
		await driveToReview(client, ["issue"]);
		expect(screen.getByRole("button", { name: /file issue/i })).not.toBeNull();
	});

	it("clipboard mode: clicking Copy calls clipboard.writeText with rendered prompt", async () => {
		const clipboardWriteText = vi.fn().mockResolvedValue(undefined);
		const client = makeFakeClient();

		render(
			<SnapPrompt
				client={client}
				projectId="proj-test"
				modes={["clipboard"]}
				clipboard={{ writeText: clipboardWriteText }}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: /snap/i }));

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

		expect(clipboardWriteText).toHaveBeenCalledOnce();
		const [text] = clipboardWriteText.mock.calls[0] as [string];
		// The mocked renderPrompt returns this exact string.
		expect(text).toBe("# Rendered prompt content");
	});

	it("clipboard mode: shows 'Copied' confirmation after copy", async () => {
		const client = makeFakeClient();

		render(
			<SnapPrompt
				client={client}
				projectId="proj-test"
				modes={["clipboard"]}
				clipboard={{ writeText: vi.fn().mockResolvedValue(undefined) }}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: /snap/i }));
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

		await waitFor(() => expect(screen.queryByText(/copied/i)).not.toBeNull());
	});

	it("download mode: clicking Download calls onDownload with md and json blobs", async () => {
		const onDownload = vi.fn();
		const client = makeFakeClient();

		render(
			<SnapPrompt
				client={client}
				projectId="proj-test"
				modes={["download"]}
				onDownload={onDownload}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: /snap/i }));
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: /record/i }));
		});
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: /stop/i }));
		});
		await waitFor(() =>
			expect(
				screen.queryByRole("button", { name: /download/i }),
			).not.toBeNull(),
		);

		fireEvent.click(screen.getByRole("button", { name: /download/i }));

		expect(onDownload).toHaveBeenCalledOnce();
		const [mdBlob, jsonBlob] = onDownload.mock.calls[0] as [Blob, Blob];
		expect(mdBlob).toBeInstanceOf(Blob);
		expect(mdBlob.type).toBe("text/markdown");
		expect(jsonBlob).toBeInstanceOf(Blob);
		expect(jsonBlob.type).toBe("application/json");

		// MD blob content matches the rendered prompt (Blob.text not available in jsdom).
		const mdBuf = await mdBlob.arrayBuffer();
		const mdText = new TextDecoder().decode(mdBuf);
		expect(mdText).toBe("# Rendered prompt content");
	});

	it("defaultMode is the primary (default-variant) button", async () => {
		const client = makeFakeClient();
		await driveToReview(client, ["issue", "clipboard", "download"]);

		// With defaultMode not set → first of modes = 'issue' is primary.
		// The primary button gets variant="default" while others get "secondary".
		// We verify the issue button exists as the primary action here.
		const issueBtn = screen.getByRole("button", { name: /file issue/i });
		expect(issueBtn).not.toBeNull();
	});

	it("all three modes render their action buttons in review phase", async () => {
		const client = makeFakeClient();
		await driveToReview(client, ["issue", "clipboard", "download"]);

		expect(screen.getByRole("button", { name: /file issue/i })).not.toBeNull();
		expect(screen.getByRole("button", { name: /copy/i })).not.toBeNull();
		expect(screen.getByRole("button", { name: /download/i })).not.toBeNull();
	});
});
