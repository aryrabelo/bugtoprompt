import { describe, expect, it } from "vitest";
import { ARTIFACT_VERSION, captureArtifactSchema } from "./index.js";

const minimalArtifact = {
	version: 1 as const,
	sessionId: "test-session-uuid-1234",
	pageUrl: "https://example.com/app",
	userAgent: "Mozilla/5.0 (Test)",
	startedAt: 1_700_000_000_000,
	durationMs: 5000,
	audio: {
		ref: "audio/recording.webm",
		mimeType: "audio/webm;codecs=opus",
		bytes: 12345,
	},
	transcript: [],
	events: [],
	snapshots: [],
	transcriptionMode: "streaming" as const,
};

describe("captureArtifactSchema", () => {
	it("parses a minimal valid artifact", () => {
		const result = captureArtifactSchema.parse(minimalArtifact);
		expect(result.sessionId).toBe("test-session-uuid-1234");
		expect(result.version).toBe(1);
	});

	it("round-trips through JSON serialization", () => {
		const parsed = captureArtifactSchema.parse(minimalArtifact);
		const roundTripped = captureArtifactSchema.parse(
			JSON.parse(JSON.stringify(parsed)),
		);
		expect(roundTripped).toEqual(parsed);
	});

	it("parses an artifact with optional fields and nested elements", () => {
		const full = {
			...minimalArtifact,
			projectId: "proj-123",
			workspaceId: "ws-456",
			branch: "main",
			transcript: [
				{ tStartMs: 0, tEndMs: 500, text: "Hello world", edited: false },
			],
			events: [
				{
					tMs: 100,
					kind: "click" as const,
					elementRef: "e1",
					elementName: "Submit",
					elementRole: "button",
					selector: "button#submit",
				},
				{ tMs: 200, kind: "route" as const, url: "https://example.com/next" },
				{ tMs: 300, kind: "mark" as const },
			],
			snapshots: [
				{
					tMs: 150,
					screenshotRef: "screenshots/snap0.png",
					screenshotMethod: "getDisplayMedia" as const,
					viewport: { width: 1280, height: 800, scrollX: 0, scrollY: 0 },
					interactiveElements: [
						{
							ref: "e1",
							role: "button",
							name: "Submit",
							selector: "button#submit",
							rect: { x: 100, y: 200, width: 80, height: 36 },
						},
					],
				},
			],
		};

		const result = captureArtifactSchema.parse(full);
		expect(result.snapshots[0]?.interactiveElements[0]?.ref).toBe("e1");
		expect(result.events[0]?.kind).toBe("click");

		const roundTripped = captureArtifactSchema.parse(
			JSON.parse(JSON.stringify(result)),
		);
		expect(roundTripped).toEqual(result);
	});

	it("throws when a required field is missing (sessionId)", () => {
		const { sessionId: _sessionId, ...withoutSessionId } = minimalArtifact;
		expect(() => captureArtifactSchema.parse(withoutSessionId)).toThrow();
	});

	it("throws when version is wrong", () => {
		expect(() =>
			captureArtifactSchema.parse({ ...minimalArtifact, version: 2 }),
		).toThrow();
	});
});

describe("ARTIFACT_VERSION", () => {
	it("is 1", () => {
		expect(ARTIFACT_VERSION).toBe(1);
	});
});
