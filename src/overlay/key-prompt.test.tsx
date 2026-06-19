/**
 * AssemblyAI key-prompt: the "paste your API key" flow that appears when live
 * transcription is unavailable. Exercises the standalone, no-backend, no-key
 * install (prompt shown + key persisted) and the host case where an explicit
 * `client` is injected (prompt never shown).
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
// Mocks — keep the heavy capture machinery inert; these tests stay at idle.
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

const STORAGE_KEY = "bugtoprompt:assemblyai-key";

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

/** Open the overlay panel by clicking the floating launcher. */
function openPanel(): void {
	fireEvent.click(screen.getByRole("button", { name: /snap/i }));
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
	vi.clearAllMocks();
	localStorage.clear();
	delete (window as Window & { __BUGTOPROMPT__?: unknown }).__BUGTOPROMPT__;
	// No backend: the zero-config /bugtoprompt/config probe must fail so
	// `auto.backend` stays false and the key prompt surfaces.
	vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("no backend")));

	mockAudioInstance = {
		streaming: false,
		start: vi.fn().mockResolvedValue(undefined),
		stop: vi.fn().mockResolvedValue({
			blob: new Blob(["audio"]),
			mimeType: "audio/webm",
			bytes: 5,
		}),
	};
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BugToPrompt AssemblyAI key prompt", () => {
	it("standalone no-backend no-key: shows the key prompt at idle and persists a saved key", async () => {
		await act(async () => {
			render(<BugToPrompt />);
		});
		openPanel();

		// The prompt heading and password input are present at idle.
		expect(screen.getByText(/enable live transcription/i)).not.toBeNull();
		const input = screen.getByLabelText(
			/assemblyai api key/i,
		) as HTMLInputElement;
		expect(input.type).toBe("password");

		// Type a key and save it.
		fireEvent.change(input, { target: { value: "  my-secret-key  " } });
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: /save/i }));
		});

		// Persisted client-side (localStorage and/or the window mirror).
		await waitFor(() => {
			const stored =
				localStorage.getItem(STORAGE_KEY) ??
				(window as Window & { __BUGTOPROMPT__?: { assemblyAiKey?: string } })
					.__BUGTOPROMPT__?.assemblyAiKey;
			expect(stored).toBe("my-secret-key");
		});
	});

	it("does not show the key prompt when an explicit client is supplied", async () => {
		await act(async () => {
			render(<BugToPrompt client={makeFakeClient()} projectId="proj-test" />);
		});
		openPanel();

		expect(screen.queryByText(/enable live transcription/i)).toBeNull();
		expect(screen.queryByLabelText(/assemblyai api key/i)).toBeNull();
	});
});
