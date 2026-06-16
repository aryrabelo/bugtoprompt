/**
 * Tests for the capture-history persistence layer (localStorage + IDB cleanup).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CaptureArtifact } from "../schema";
import type { CaptureRecord, OutputMode } from "./session-store";
import {
	addCapture,
	clearHistory,
	listCaptures,
	loadShots,
	putShot,
	removeCapture,
} from "./session-store";

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

function makeRecord(
	id: string,
	overrides: Partial<CaptureRecord> = {},
): CaptureRecord {
	return {
		v: 1,
		id,
		title: `Capture ${id}`,
		createdAt: Date.now(),
		pageUrl: `https://example.com/${id}`,
		prompt: `# Prompt for ${id}`,
		artifact: makeArtifact(id),
		mode: "clipboard" as OutputMode,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
	localStorage.clear();
});

afterEach(() => {
	localStorage.clear();
});

// ---------------------------------------------------------------------------
// addCapture / listCaptures
// ---------------------------------------------------------------------------

describe("addCapture / listCaptures", () => {
	it("listCaptures returns [] when nothing is stored", () => {
		expect(listCaptures()).toEqual([]);
	});

	it("addCapture prepends a new record and listCaptures returns it", () => {
		const rec = makeRecord("cap-1");
		addCapture(rec);
		const list = listCaptures();
		expect(list).toHaveLength(1);
		expect(list[0].id).toBe("cap-1");
	});

	it("prepends — newest first", () => {
		addCapture(makeRecord("a"));
		addCapture(makeRecord("b"));
		const list = listCaptures();
		expect(list[0].id).toBe("b");
		expect(list[1].id).toBe("a");
	});

	it("dedupes by id — second add replaces existing entry and moves it to front", () => {
		const first = makeRecord("dup", { title: "First" });
		const second = makeRecord("dup", { title: "Second" });
		addCapture(first);
		addCapture(makeRecord("other"));
		addCapture(second);
		const list = listCaptures();
		expect(list.filter((r) => r.id === "dup")).toHaveLength(1);
		expect(list[0].id).toBe("dup");
		expect(list[0].title).toBe("Second");
	});

	it("caps at 50 entries", () => {
		for (let i = 0; i < 55; i++) {
			addCapture(makeRecord(`cap-${i}`));
		}
		expect(listCaptures()).toHaveLength(50);
	});

	it("listCaptures returns [] for garbage JSON", () => {
		localStorage.setItem("snap-prompt:history", "not-json{{");
		expect(listCaptures()).toEqual([]);
	});

	it("listCaptures returns [] when stored value is not an array", () => {
		localStorage.setItem("snap-prompt:history", JSON.stringify({ v: 1 }));
		expect(listCaptures()).toEqual([]);
	});

	it("listCaptures drops entries where v !== 1", () => {
		const good = makeRecord("good");
		const bad = { ...makeRecord("bad"), v: 2 };
		localStorage.setItem("snap-prompt:history", JSON.stringify([good, bad]));
		const list = listCaptures();
		expect(list).toHaveLength(1);
		expect(list[0].id).toBe("good");
	});
});

// ---------------------------------------------------------------------------
// removeCapture
// ---------------------------------------------------------------------------

describe("removeCapture", () => {
	it("removes the matching record from the list", async () => {
		addCapture(makeRecord("keep"));
		addCapture(makeRecord("gone"));
		await removeCapture("gone");
		const list = listCaptures();
		expect(list).toHaveLength(1);
		expect(list[0].id).toBe("keep");
	});

	it("is a no-op when id is not in the list", async () => {
		addCapture(makeRecord("stays"));
		await removeCapture("nonexistent");
		expect(listCaptures()).toHaveLength(1);
	});

	it("deletes associated IDB blobs via clearShots", async () => {
		const id = "blob-session";
		await putShot(id, 0, new Blob(["data"]));
		addCapture(makeRecord(id));
		await removeCapture(id);
		const blobs = await loadShots(id, 1);
		expect(blobs[0]).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// clearHistory
// ---------------------------------------------------------------------------

describe("clearHistory", () => {
	it("empties the capture list", async () => {
		addCapture(makeRecord("a"));
		addCapture(makeRecord("b"));
		await clearHistory();
		expect(listCaptures()).toEqual([]);
	});

	it("deletes IDB blobs for all record ids", async () => {
		// Put blobs into IDB for two different sessions.
		await putShot("x", 0, new Blob(["x-data"]));
		await putShot("y", 0, new Blob(["y-data"]));
		addCapture(makeRecord("x"));
		addCapture(makeRecord("y"));
		await clearHistory();
		// Both sessions' blobs should now be gone.
		expect(await loadShots("x", 1)).toEqual([null]);
		expect(await loadShots("y", 1)).toEqual([null]);
	});

	it("is a no-op when the list is already empty", async () => {
		await expect(clearHistory()).resolves.toBeUndefined();
		expect(listCaptures()).toEqual([]);
	});
});
