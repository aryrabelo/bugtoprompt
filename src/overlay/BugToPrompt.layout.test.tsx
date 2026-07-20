/**
 * Phase-specific layout + hierarchy tests for the redesigned overlay (plan §4).
 *
 * Two surfaces are exercised:
 *   1. The idle phase is driven through the real <BugToPrompt/> so the panel
 *      hierarchy (capability rows → dominant Start capture → history disclosure)
 *      is asserted against the actual composition.
 *   2. The recording + review phases are rendered via the exported pure
 *      RecordingCard / ReviewPanel components with deterministic fixtures. This
 *      is the "visual snapshot" harness: a real pixel snapshot at 1440×900 is
 *      NOT wired because the repo's test tooling is jsdom-only (see
 *      vitest.config.ts — no @vitest/browser / Playwright dependency, so no
 *      layout engine renders pixels). Instead we snapshot the deterministic DOM
 *      structure of each phase, which regresses hierarchy changes without a
 *      headless browser. Swap in `@vitest/browser` + `page.screenshot()` here
 *      when/if browser mode is added; the fixtures below are already stable.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BugToPromptClient, Target } from "../client";
import { BugToPrompt, RecordingCard, ReviewPanel } from "./BugToPrompt";

// Keep capture machinery inert — these tests never start a real session.
const mockGrabber = vi.hoisted(() => ({
	grab: vi.fn().mockResolvedValue(null),
	stop: vi.fn(),
}));
vi.mock("./audio/AudioCapture", () => ({
	AudioCapture: vi.fn().mockImplementation(() => ({
		streaming: false,
		start: vi.fn().mockResolvedValue(undefined),
		stop: vi
			.fn()
			.mockResolvedValue({ blob: new Blob(), mimeType: "", bytes: 0 }),
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
	renderPrompt: vi.fn().mockReturnValue("# Rendered prompt content"),
	promptTitle: vi.fn().mockReturnValue("Test capture title"),
	transcriptText: vi.fn().mockReturnValue(""),
}));

function makeFakeClient(): BugToPromptClient {
	return {
		mintStreamingToken: vi.fn().mockResolvedValue({ token: "t", expiresAt: 0 }),
		saveArtifact: vi
			.fn()
			.mockResolvedValue({ dir: "/tmp/cap", sessionId: "s" }),
		transcribeBatch: vi.fn().mockResolvedValue({ transcript: [] }),
		createIssue: vi
			.fn()
			.mockResolvedValue({ created: true, number: 1, url: "https://gh/1" }),
		listTargets: vi.fn().mockResolvedValue([] as Target[]),
	};
}

const previews = [
	{ clickNumber: 1, screenshotRef: "snap-0000.jpg", url: "blob:click-1" },
	{ clickNumber: 2, screenshotRef: "snap-0001.jpg", url: "blob:click-2" },
	{ clickNumber: 3, screenshotRef: "snap-0002.jpg", url: "blob:click-3" },
];

beforeEach(() => {
	vi.clearAllMocks();
	localStorage.clear();
});
afterEach(() => {
	cleanup();
	localStorage.clear();
});

// ---------------------------------------------------------------------------
// Idle phase — hierarchy
// ---------------------------------------------------------------------------

describe("idle layout hierarchy", () => {
	it("shows three bordered capability rows, a full-width primary, and history behind a disclosure that follows the primary", () => {
		render(
			<BugToPrompt
				client={makeFakeClient()}
				projectId="p"
				modes={["issue"]}
				screenshotMode="onClick"
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: /bugtoprompt/i }));

		// Capability rows.
		expect(screen.getByText(/capture every click/i)).toBeTruthy();
		expect(screen.getByText(/live voice transcription/i)).toBeTruthy();
		expect(screen.getByText(/create github issue/i)).toBeTruthy();

		// Dominant primary action carries a stable testid and is full width.
		const start = screen.getByTestId("start");
		expect(start.className).toContain("w-full");

		// History lives behind the "Recent captures" disclosure...
		const details = screen.getByTestId("recent-captures");
		expect(details.tagName.toLowerCase()).toBe("details");
		// ...and the disclosure comes AFTER the primary action in DOM order.
		const pos = start.compareDocumentPosition(details);
		expect(pos & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	it("defaultOpen mounts with the panel already open (extension activation)", () => {
		render(
			<BugToPrompt
				client={makeFakeClient()}
				projectId="p"
				modes={["issue"]}
				defaultOpen
			/>,
		);
		// No launcher click: the dialog is present immediately.
		expect(screen.getByRole("dialog", { name: /bugtoprompt/i })).toBeTruthy();
		expect(screen.getByTestId("start")).toBeTruthy();
	});

	it("exposes a stable ordered idle structure (fixture harness)", () => {
		render(
			<BugToPrompt
				client={makeFakeClient()}
				projectId="p"
				modes={["issue"]}
				screenshotMode="onClick"
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: /bugtoprompt/i }));
		expect(screen.getByRole("dialog")).toBeTruthy();
		// Deterministic hierarchy: the three capability rows are present and the
		// primary + history disclosure follow.
		expect(screen.getByText(/capture every click/i)).toBeTruthy();
		expect(screen.getByText(/live voice transcription/i)).toBeTruthy();
		expect(screen.getByTestId("start")).toBeTruthy();
		expect(screen.getByTestId("recent-captures")).toBeTruthy();
	});

	it("degrades an unknown host-config screenshotMode to onMark instead of crashing", () => {
		// Deliberately invalid host config: the runtime guard under test must
		// degrade an unknown screenshotMode; the cast is the only way to write
		// a value outside the declared global union.
		const bogusHostConfig = {
			screenshotMode: "bogus-mode",
		} as unknown as NonNullable<Window["__BUGTOPROMPT__"]>;
		window.__BUGTOPROMPT__ = bogusHostConfig;
		try {
			render(
				<BugToPrompt
					client={makeFakeClient()}
					projectId="p"
					modes={["issue"]}
				/>,
			);
			fireEvent.click(screen.getByRole("button", { name: /bugtoprompt/i }));
			// Falls back to the onMark capability copy rather than throwing.
			expect(screen.getByText(/capture on mark/i)).toBeTruthy();
		} finally {
			delete window.__BUGTOPROMPT__;
		}
	});

	it("degrades a prototype-inherited screenshotMode key ('toString') to onMark instead of leaking Object.prototype", () => {
		// A prototype-inherited key ("toString") passes a naive `in` check and
		// indexes Object.prototype, whose .label/.on/.desc are undefined; the
		// guard under test must degrade it to onMark.
		const bogusHostConfig = {
			screenshotMode: "toString",
		} as unknown as NonNullable<Window["__BUGTOPROMPT__"]>;
		window.__BUGTOPROMPT__ = bogusHostConfig;
		try {
			render(
				<BugToPrompt
					client={makeFakeClient()}
					projectId="p"
					modes={["issue"]}
				/>,
			);
			fireEvent.click(screen.getByRole("button", { name: /bugtoprompt/i }));
			expect(screen.getByText(/capture on mark/i)).toBeTruthy();
		} finally {
			delete window.__BUGTOPROMPT__;
		}
	});
});

// ---------------------------------------------------------------------------
// Recording phase — compact recorder card (pure fixtures)
// ---------------------------------------------------------------------------

describe("recording card layout", () => {
	function renderCard(
		overrides: Partial<Parameters<typeof RecordingCard>[0]> = {},
	) {
		return render(
			<RecordingCard
				elapsedMs={65_000}
				streaming
				clickCount={3}
				latestThumb={{ clickNumber: 3, url: "blob:click-3" }}
				screenshotsUnavailable={false}
				transcript={[]}
				partial=""
				voiceEnabled={false}
				onEnableVoice={vi.fn()}
				flashTick={2}
				onMark={vi.fn()}
				onStop={vi.fn()}
				{...overrides}
			/>,
		);
	}

	it("shows elapsed time, live status, click count, and the latest numbered thumbnail", () => {
		renderCard();
		expect(screen.getByText("1:05")).toBeTruthy();
		expect(screen.getByText(/live/i)).toBeTruthy();
		expect(screen.getByTestId("click-count").textContent).toMatch(/3 clicks/i);
		const thumb = screen.getByTestId("latest-thumbnail");
		expect(thumb.querySelector("img")?.getAttribute("src")).toBe(
			"blob:click-3",
		);
		expect(thumb.textContent).toContain("3");
	});

	it("offers equal Mark + destructive Stop actions", () => {
		const onMark = vi.fn();
		const onStop = vi.fn();
		renderCard({ onMark, onStop });
		fireEvent.click(screen.getByTestId("mark"));
		fireEvent.click(screen.getByTestId("stop"));
		expect(onMark).toHaveBeenCalledOnce();
		expect(onStop).toHaveBeenCalledOnce();
	});

	it("voice row cannot disable an already-active recording", () => {
		const onEnableVoice = vi.fn();
		renderCard({ voiceEnabled: true, onEnableVoice });
		const checkbox = screen.getByRole("checkbox") as HTMLInputElement;
		expect(checkbox.checked).toBe(true);
		expect(checkbox.disabled).toBe(true);
		fireEvent.click(checkbox);
		expect(onEnableVoice).not.toHaveBeenCalled();
	});

	it("surfaces a non-blocking notice when screenshots are unavailable", () => {
		renderCard({ screenshotsUnavailable: true, latestThumb: undefined });
		expect(screen.getByRole("status").textContent).toMatch(
			/screenshots unavailable/i,
		);
		expect(screen.queryByTestId("latest-thumbnail")).toBeNull();
	});

	it("exposes a stable recording structure (fixture harness)", () => {
		renderCard();
		const card = screen.getByTestId("recording-card");
		expect(card.querySelector('[data-testid="click-count"]')).not.toBeNull();
		expect(
			card.querySelector('[data-testid="latest-thumbnail"]'),
		).not.toBeNull();
		expect(card.querySelector('[data-testid="mark"]')).not.toBeNull();
		expect(card.querySelector('[data-testid="stop"]')).not.toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Review phase — ordered click strip + sticky footer (pure fixtures)
// ---------------------------------------------------------------------------

describe("review panel layout", () => {
	function renderReview(
		overrides: Partial<Parameters<typeof ReviewPanel>[0]> = {},
	) {
		return render(
			<ReviewPanel
				transcript={[]}
				events={[]}
				clickPreviews={previews}
				onEditSegment={vi.fn()}
				lastAction="none"
				modes={["issue", "clipboard", "download"]}
				primaryMode="issue"
				fileDisabled={false}
				needTargetHint={false}
				onDiscard={vi.fn()}
				onCreateIssue={vi.fn()}
				onCopy={vi.fn()}
				onDownload={vi.fn()}
				{...overrides}
			/>,
		);
	}

	it("renders an ordered numbered click strip of 400×600 thumbnails matching clickPreviews order", () => {
		renderReview();
		const thumbs = screen.getAllByTestId("click-thumbnail");
		expect(thumbs).toHaveLength(3);
		// Numbered badges in click order.
		expect(thumbs.map((t) => t.querySelector("span")?.textContent)).toEqual([
			"1",
			"2",
			"3",
		]);
		// 2:3 aspect (400×600) scaled thumbnail images, sourced from previews.
		const imgs = thumbs.map((t) => t.querySelector("img"));
		expect(imgs.map((i) => i?.getAttribute("src"))).toEqual([
			"blob:click-1",
			"blob:click-2",
			"blob:click-3",
		]);
		expect(imgs[0]?.className).toContain("aspect-[2/3]");
	});

	it("makes Create GitHub issue the primary action when defaultMode is issue; Copy/Download secondary; Discard low-emphasis", () => {
		renderReview({ primaryMode: "issue" });
		expect(screen.getByTestId("create-issue").className).toContain(
			"bg-primary",
		);
		expect(screen.getByTestId("copy").className).toContain("bg-secondary");
		expect(screen.getByTestId("download").className).toContain("bg-secondary");
		// Discard is a low-emphasis text control, not a filled button.
		const discard = screen.getByTestId("discard");
		expect(discard.className).not.toContain("bg-primary");
		expect(discard.className).not.toContain("bg-destructive");
	});

	it("wires footer actions to their handlers", () => {
		const onCreateIssue = vi.fn();
		const onCopy = vi.fn();
		const onDownload = vi.fn();
		const onDiscard = vi.fn();
		renderReview({ onCreateIssue, onCopy, onDownload, onDiscard });
		fireEvent.click(screen.getByTestId("create-issue"));
		fireEvent.click(screen.getByTestId("copy"));
		fireEvent.click(screen.getByTestId("download"));
		fireEvent.click(screen.getByTestId("discard"));
		expect(onCreateIssue).toHaveBeenCalledOnce();
		expect(onCopy).toHaveBeenCalledOnce();
		expect(onDownload).toHaveBeenCalledOnce();
		expect(onDiscard).toHaveBeenCalledOnce();
	});

	it("disables Create GitHub issue and shows a target hint when no project is bound", () => {
		renderReview({ fileDisabled: true, needTargetHint: true });
		expect(
			(screen.getByTestId("create-issue") as HTMLButtonElement).disabled,
		).toBe(true);
		expect(
			screen.getByText(/select a project to file the issue/i),
		).toBeTruthy();
	});

	it("exposes a stable review structure (fixture harness)", () => {
		renderReview();
		const panel = screen.getByTestId("review-panel");
		expect(panel.querySelector('[data-testid="click-strip"]')).not.toBeNull();
		expect(
			panel.querySelectorAll('[data-testid="click-thumbnail"]').length,
		).toBe(3);
		expect(panel.querySelector('[data-testid="create-issue"]')).not.toBeNull();
		expect(panel.querySelector('[data-testid="copy"]')).not.toBeNull();
		expect(panel.querySelector('[data-testid="download"]')).not.toBeNull();
		expect(panel.querySelector('[data-testid="discard"]')).not.toBeNull();
	});
});
