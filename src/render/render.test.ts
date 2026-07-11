import { describe, expect, it } from "vitest";
import type { CaptureArtifact } from "../schema";
import { CAPTURE_MARKER_PREFIX, promptTitle, renderPrompt } from "./index";

// ---------------------------------------------------------------------------
// Representative fixture
// ---------------------------------------------------------------------------

const BASE_ARTIFACT: CaptureArtifact = {
	version: 1,
	sessionId: "ses-test-001",
	projectId: "proj-x",
	pageUrl: "https://app.example.com/settings",
	userAgent: "Mozilla/5.0 (Test)",
	startedAt: 1_700_000_000_000,
	durationMs: 12_500,
	audio: { ref: "audio.webm", mimeType: "audio/webm", bytes: 4096 },
	transcript: [
		{ tStartMs: 0, tEndMs: 1500, text: "The save button is broken" },
		{ tStartMs: 2000, tEndMs: 3500, text: "It does nothing when clicked" },
	],
	events: [
		{
			tMs: 800,
			kind: "click",
			elementName: "Save",
			elementRole: "button",
			selector: "#save-btn",
		},
		{ tMs: 1800, kind: "route", url: "https://app.example.com/settings/saved" },
		{ tMs: 5000, kind: "mark" },
	],
	snapshots: [
		{
			tMs: 800,
			screenshotRef: "snap-0000.png",
			screenshotMethod: "getDisplayMedia",
			viewport: { width: 1280, height: 800, scrollX: 0, scrollY: 0 },
			interactiveElements: [
				{
					ref: "e1",
					role: "button",
					name: "Save",
					selector: "#save-btn",
					rect: { x: 100, y: 200, width: 80, height: 36 },
				},
			],
		},
		{
			// Snapshot with no screenshotRef (screen capture denied)
			tMs: 5000,
			viewport: { width: 1280, height: 800, scrollX: 0, scrollY: 100 },
			interactiveElements: [],
		},
	],
	transcriptionMode: "streaming",
};

// ---------------------------------------------------------------------------
// promptTitle
// ---------------------------------------------------------------------------

describe("promptTitle", () => {
	it("returns the first non-empty transcript segment text", () => {
		const title = promptTitle(BASE_ARTIFACT);
		expect(title).toBe("The save button is broken");
	});

	it("falls back to page path when transcript is empty", () => {
		const art: CaptureArtifact = { ...BASE_ARTIFACT, transcript: [] };
		const title = promptTitle(art);
		expect(title).toContain("/settings");
	});

	it("truncates titles longer than 72 chars with an ellipsis", () => {
		const longText = "A".repeat(80);
		const art: CaptureArtifact = {
			...BASE_ARTIFACT,
			transcript: [{ tStartMs: 0, tEndMs: 1000, text: longText }],
		};
		const title = promptTitle(art);
		expect(title.length).toBeLessThanOrEqual(72);
		expect(title.endsWith("…")).toBe(true);
	});

	it("redacts credentials in the title", () => {
		const art: CaptureArtifact = {
			...BASE_ARTIFACT,
			transcript: [
				{ tStartMs: 0, tEndMs: 1000, text: "token=ghp_abcdefghijklmnopqrstu" },
			],
		};
		expect(promptTitle(art)).not.toContain("ghp_");
	});
});

// ---------------------------------------------------------------------------
// renderPrompt — structure
// ---------------------------------------------------------------------------

describe("renderPrompt", () => {
	it("body starts with the page URL header", () => {
		const body = renderPrompt(BASE_ARTIFACT);
		expect(body).toContain("**Page:** https://app.example.com/settings");
	});

	it("body contains a Caption block with transcript text", () => {
		const body = renderPrompt(BASE_ARTIFACT);
		expect(body).toContain("## Caption");
		expect(body).toContain('🗣 "The save button is broken"');
		expect(body).toContain('🗣 "It does nothing when clicked"');
	});

	it("renders a select event as a highlighted-text caption row", () => {
		const art: CaptureArtifact = {
			...BASE_ARTIFACT,
			events: [
				...BASE_ARTIFACT.events,
				{
					tMs: 1200,
					kind: "select",
					selectedText: "essa parte aqui",
					selector: "h1.landing-headline",
				},
			],
		};
		const body = renderPrompt(art);
		expect(body).toContain('✂️ selected "essa parte aqui"');
	});

	it("body contains the clicked-elements machine JSON", () => {
		const body = renderPrompt(BASE_ARTIFACT);
		expect(body).toContain("<details>");
		expect(body).toContain("Clicked elements (machine-readable)");
		expect(body).toContain('"selector": "#save-btn"');
	});

	it("screenshot with ref renders as a path reference", () => {
		const body = renderPrompt(BASE_ARTIFACT);
		// Without artifactDir — just the ref name.
		expect(body).toContain("snap-0000.png");
	});

	it("screenshot with ref + artifactDir renders as full path", () => {
		const body = renderPrompt(BASE_ARTIFACT, { artifactDir: "/tmp/cap" });
		expect(body).toContain("`/tmp/cap/snap-0000.png`");
	});

	it("screenshot with ref + screenshotUrls renders as inline image", () => {
		const body = renderPrompt(BASE_ARTIFACT, {
			screenshotUrls: { "snap-0000.png": "https://cdn.example.com/img.png" },
		});
		expect(body).toContain("![snap @");
		expect(body).toContain("https://cdn.example.com/img.png");
	});

	it("snapshot without screenshotRef renders as 'interactive snapshot only'", () => {
		const body = renderPrompt(BASE_ARTIFACT);
		expect(body).toContain("interactive snapshot only");
	});

	it("renders a numbered click with its screenshot ref inline in the caption", () => {
		const art: CaptureArtifact = {
			...BASE_ARTIFACT,
			events: [
				{
					tMs: 800,
					kind: "click",
					elementName: "Save",
					elementRole: "button",
					selector: "#save-btn",
					clickNumber: 1,
					screenshotRef: "snap-0000.jpg",
				},
			],
		};
		const body = renderPrompt(art);
		expect(body).toContain("🖱 click #1 <Save> (button) — `snap-0000.jpg`");
	});

	it("old artifact without clickNumber renders the click line without a number", () => {
		// BASE_ARTIFACT's click has neither clickNumber nor screenshotRef.
		const body = renderPrompt(BASE_ARTIFACT);
		expect(body).toContain("🖱 click <Save> (button)");
		expect(body).not.toContain("🖱 click #");
	});

	it("body ends with the CAPTURE_MARKER_PREFIX and sessionId", () => {
		const body = renderPrompt(BASE_ARTIFACT);
		expect(body).toContain(`${CAPTURE_MARKER_PREFIX} ses-test-001`);
	});

	it("output is deterministic across calls", () => {
		expect(renderPrompt(BASE_ARTIFACT)).toBe(renderPrompt(BASE_ARTIFACT));
	});

	it("redacts a credential-shaped substring", () => {
		const art: CaptureArtifact = {
			...BASE_ARTIFACT,
			transcript: [
				{
					tStartMs: 0,
					tEndMs: 1000,
					text: "token is ghp_abcdefghijklmnopqrstu value here",
				},
			],
		};
		const body = renderPrompt(art);
		expect(body).not.toContain("ghp_abcdefghijklmnopqrstu");
		expect(body).toContain("[redacted]");
	});

	it("oversized caption is truncated to stay under BODY_MAX", () => {
		// Build an artifact with a very long transcript that would bust 60k chars.
		const bigText = "x".repeat(500);
		const manySegs = Array.from({ length: 200 }, (_, i) => ({
			tStartMs: i * 100,
			tEndMs: i * 100 + 50,
			text: bigText,
		}));
		const art: CaptureArtifact = { ...BASE_ARTIFACT, transcript: manySegs };
		const body = renderPrompt(art);
		expect(body.length).toBeLessThanOrEqual(60_000);
	});
});

// ---------------------------------------------------------------------------
// CAPTURE_MARKER_PREFIX
// ---------------------------------------------------------------------------

describe("CAPTURE_MARKER_PREFIX", () => {
	it("is the generic bugtoprompt marker", () => {
		expect(CAPTURE_MARKER_PREFIX).toBe("bugtoprompt-capture-id:");
	});
});
