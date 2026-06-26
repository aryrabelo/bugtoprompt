/**
 * Tests for the SessionStore persistence layer.
 *
 * fake-indexeddb/auto is loaded in test-setup.ts and provides a real IndexedDB
 * implementation inside jsdom.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PersistedSession } from "./session-store";
import {
	clearSession,
	loadSession,
	loadShots,
	putShot,
	removeSession,
	saveSession,
} from "./session-store";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(
	overrides: Partial<PersistedSession> = {},
): PersistedSession {
	return {
		v: 1,
		sessionId: "cap_test-123",
		startedAt: Date.now() - 5000,
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
		transcript: [{ tStartMs: 0, tEndMs: 1000, text: "hello" }],
		durationMs: 5000,
		...overrides,
	};
}

async function seedCorruptScreenshotsDb(): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const del = indexedDB.deleteDatabase("bugtoprompt-sessions");
		del.onsuccess = () => resolve();
		del.onerror = () => reject(del.error);
		del.onblocked = () => reject(new Error("delete blocked"));
	});
	await new Promise<void>((resolve, reject) => {
		const req = indexedDB.open("bugtoprompt-sessions", 99);
		req.onupgradeneeded = () => {
			// Intentionally leave out the screenshots store to simulate a stale/corrupt DB.
		};
		req.onsuccess = () => {
			req.result.close();
			resolve();
		};
		req.onerror = () => reject(req.error);
	});
}

// ---------------------------------------------------------------------------
// localStorage — saveSession / loadSession
// ---------------------------------------------------------------------------

describe("saveSession / loadSession round-trip", () => {
	beforeEach(() => {
		localStorage.clear();
	});

	afterEach(() => {
		localStorage.clear();
	});

	it("saves and reloads a session with all fields intact", () => {
		const s = makeSession();
		saveSession(s);
		const loaded = loadSession();
		expect(loaded).toEqual(s);
	});

	it("returns null when nothing is stored", () => {
		expect(loadSession()).toBeNull();
	});

	it("returns null for garbage JSON", () => {
		localStorage.setItem("bugtoprompt:session", "not-json{{{");
		expect(loadSession()).toBeNull();
	});

	it("returns null when stored object has v !== 1", () => {
		localStorage.setItem(
			"bugtoprompt:session",
			JSON.stringify({ v: 2, sessionId: "x" }),
		);
		expect(loadSession()).toBeNull();
	});

	it("returns null for an empty object (no v)", () => {
		localStorage.setItem("bugtoprompt:session", JSON.stringify({}));
		expect(loadSession()).toBeNull();
	});

	it("removeSession wipes the entry", () => {
		saveSession(makeSession());
		removeSession();
		expect(loadSession()).toBeNull();
	});

	it("overwrites a previous session on re-save", () => {
		saveSession(makeSession({ sessionId: "cap_old" }));
		saveSession(makeSession({ sessionId: "cap_new" }));
		expect(loadSession()?.sessionId).toBe("cap_new");
	});
});

// ---------------------------------------------------------------------------
// IndexedDB — putShot / loadShots
// ---------------------------------------------------------------------------

describe("putShot / loadShots", () => {
	const sessionId = "cap_idb-test";

	afterEach(async () => {
		await clearSession(sessionId);
	});

	it("stores blobs and retrieves them by index", async () => {
		const blob0 = new Blob(["aa"], { type: "image/png" });
		const blob1 = new Blob(["bbbbb"], { type: "image/png" });

		await putShot(sessionId, 0, blob0);
		await putShot(sessionId, 1, blob1);

		const shots = await loadShots(sessionId, 2);
		expect(shots).toHaveLength(2);
		// Verify the blobs are non-null (stored + retrieved successfully).
		// We avoid inspecting .size / .text() because fake-indexeddb's structured
		// clone may return a non-jsdom Blob realm object in the test environment.
		expect(shots[0]).not.toBeNull();
		expect(shots[1]).not.toBeNull();
	});

	it("self-heals a DB missing the screenshots store", async () => {
		await seedCorruptScreenshotsDb();
		const empty = await loadShots(sessionId, 2);
		expect(empty).toEqual([null, null]);

		await putShot(sessionId, 0, new Blob(["aa"], { type: "image/png" }));
		const repaired = await loadShots(sessionId, 1);
		expect(repaired[0]).not.toBeNull();
	});

	it("returns null for missing slot indices", async () => {
		// Only index 2 is stored — 0 and 1 must come back null.
		await putShot(sessionId, 2, new Blob(["xyz"], { type: "image/png" }));

		const shots = await loadShots(sessionId, 3);
		expect(shots[0]).toBeNull();
		expect(shots[1]).toBeNull();
		expect(shots[2]).not.toBeNull();
	});

	it("returns empty array for count 0", async () => {
		const shots = await loadShots(sessionId, 0);
		expect(shots).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// clearSession
// ---------------------------------------------------------------------------

describe("clearSession", () => {
	const sessionId = "cap_clear-test";

	beforeEach(() => {
		localStorage.clear();
	});

	it("removes the localStorage entry and all IDB blobs", async () => {
		const s = makeSession({ sessionId });
		saveSession(s);
		await putShot(sessionId, 0, new Blob(["img"], { type: "image/png" }));
		await putShot(sessionId, 1, new Blob(["img2"], { type: "image/png" }));

		await clearSession(sessionId);

		expect(loadSession()).toBeNull();
		const shots = await loadShots(sessionId, 2);
		expect(shots[0]).toBeNull();
		expect(shots[1]).toBeNull();
	});
});
