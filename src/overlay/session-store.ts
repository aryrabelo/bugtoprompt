/**
 * SessionStore — lightweight persistence for cross-page capture sessions.
 *
 * localStorage (key `bugtoprompt:session`) holds the compact session state:
 * IDs, timeline events, DOM snapshots (metadata), and transcript.
 * IndexedDB (db `bugtoprompt`, store `screenshots`) holds the screenshot blobs
 * keyed by `${sessionId}:${index}` — localStorage's ~5 MB cap can't hold images.
 *
 * All browser storage accesses are guarded for SSR / jsdom environments where
 * `localStorage` or `indexedDB` may be absent.
 */
import type {
	CaptureArtifact,
	CaptureEvent,
	CaptureSnapshot,
	TranscriptSegment,
} from "../schema";

/** Which pages should capture screenshots. */
export type ScreenshotMode = "perPage" | "onMark" | "off";
/** Which output a capture was sent to. */
export type OutputMode = "issue" | "clipboard" | "download";

/** One finished capture as stored in the local history. */
export interface CaptureRecord {
	v: 1;
	/** Same as artifact.sessionId — the dedup key. */
	id: string;
	title: string;
	createdAt: number;
	pageUrl: string;
	prompt: string;
	artifact: CaptureArtifact;
	mode: OutputMode;
}

/** The target binding frozen at record-start. */
export interface SessionBinding {
	projectId?: string;
	workspaceId?: string;
	branch?: string;
}

export interface PersistedSession {
	v: 1;
	sessionId: string;
	startedAt: number;
	binding: SessionBinding;
	status: "recording" | "reviewing";
	events: CaptureEvent[];
	snapshots: CaptureSnapshot[];
	transcript: TranscriptSegment[];
	durationMs: number;
}

// ---------------------------------------------------------------------------
// localStorage helpers
// ---------------------------------------------------------------------------

const LS_KEY = "bugtoprompt:session";

// ---------------------------------------------------------------------------
// localStorage — capture history
// ---------------------------------------------------------------------------

const LS_HISTORY_KEY = "bugtoprompt:history";
const HISTORY_MAX = 50;

/** Prepend a finished capture, deduping by id, capped at 50. */
export function addCapture(rec: CaptureRecord): void {
	if (typeof localStorage === "undefined") return;
	try {
		const current = listCaptures();
		const filtered = current.filter((r) => r.id !== rec.id);
		const next = [rec, ...filtered].slice(0, HISTORY_MAX);
		localStorage.setItem(LS_HISTORY_KEY, JSON.stringify(next));
	} catch {
		// Ignore QuotaExceededError / SecurityError
	}
}

/** Return the history list (newest first). Drops entries with v !== 1. */
export function listCaptures(): CaptureRecord[] {
	if (typeof localStorage === "undefined") return [];
	try {
		const raw = localStorage.getItem(LS_HISTORY_KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(
			(r): r is CaptureRecord =>
				typeof r === "object" && r !== null && (r as { v?: unknown }).v === 1,
		);
	} catch {
		return [];
	}
}

/** Remove one capture from the list and delete its IndexedDB blobs. */
export async function removeCapture(id: string): Promise<void> {
	if (typeof localStorage !== "undefined") {
		try {
			const current = listCaptures();
			const next = current.filter((r) => r.id !== id);
			localStorage.setItem(LS_HISTORY_KEY, JSON.stringify(next));
		} catch {
			// Ignore
		}
	}
	await clearShots(id);
}

/** Clear the entire history list and delete all associated IndexedDB blobs. */
export async function clearHistory(): Promise<void> {
	const ids = listCaptures().map((r) => r.id);
	if (typeof localStorage !== "undefined") {
		try {
			localStorage.removeItem(LS_HISTORY_KEY);
		} catch {
			// Ignore
		}
	}
	for (const id of ids) {
		await clearShots(id);
	}
}

export function saveSession(s: PersistedSession): void {
	if (typeof localStorage === "undefined") return;
	try {
		localStorage.setItem(LS_KEY, JSON.stringify(s));
	} catch {
		// Ignore QuotaExceededError / SecurityError
	}
}

export function loadSession(): PersistedSession | null {
	if (typeof localStorage === "undefined") return null;
	try {
		const raw = localStorage.getItem(LS_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as unknown;
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			(parsed as { v?: unknown }).v !== 1
		)
			return null;
		return parsed as PersistedSession;
	} catch {
		return null;
	}
}

export function removeSession(): void {
	if (typeof localStorage === "undefined") return;
	try {
		localStorage.removeItem(LS_KEY);
	} catch {
		// Ignore
	}
}

// ---------------------------------------------------------------------------
// IndexedDB helpers
// ---------------------------------------------------------------------------

const IDB_NAME = "bugtoprompt-sessions";
const IDB_STORE = "screenshots";

function openDb(recovered = false): Promise<IDBDatabase> {
	return new Promise<IDBDatabase>((resolve, reject) => {
		const req = indexedDB.open(IDB_NAME);
		req.onupgradeneeded = () => {
			if (!req.result.objectStoreNames.contains(IDB_STORE)) {
				req.result.createObjectStore(IDB_STORE);
			}
		};
		req.onsuccess = () => {
			const db = req.result;
			if (db.objectStoreNames.contains(IDB_STORE)) {
				resolve(db);
				return;
			}
			db.close();
			if (recovered) {
				reject(
					new Error(`IndexedDB store "${IDB_STORE}" missing after recovery`),
				);
				return;
			}
			const del = indexedDB.deleteDatabase(IDB_NAME);
			del.onsuccess = () => void openDb(true).then(resolve, reject);
			del.onerror = () => reject(del.error);
			del.onblocked = () =>
				reject(new Error(`IndexedDB delete blocked for "${IDB_NAME}"`));
		};
		req.onerror = () => reject(req.error);
	});
}

/**
 * Persist a screenshot blob keyed by `${sessionId}:${index}`.
 * No-op when IndexedDB is unavailable (SSR / restricted env).
 */
export async function putShot(
	sessionId: string,
	index: number,
	blob: Blob,
): Promise<void> {
	if (typeof indexedDB === "undefined") return;
	const db = await openDb();
	return new Promise<void>((resolve, reject) => {
		const tx = db.transaction(IDB_STORE, "readwrite");
		tx.oncomplete = () => {
			db.close();
			resolve();
		};
		tx.onerror = () => {
			db.close();
			reject(tx.error);
		};
		tx.objectStore(IDB_STORE).put(blob, `${sessionId}:${index}`);
	});
}

/**
 * Load `count` blobs for a session in index order.
 * Slots with no stored blob resolve to `null`.
 */
export async function loadShots(
	sessionId: string,
	count: number,
): Promise<Array<Blob | null>> {
	if (count === 0) return [];
	if (typeof indexedDB === "undefined")
		return Array.from({ length: count }, () => null);
	const db = await openDb();
	return new Promise<Array<Blob | null>>((resolve, reject) => {
		const tx = db.transaction(IDB_STORE, "readonly");
		const store = tx.objectStore(IDB_STORE);
		const results: Array<Blob | null> = Array.from(
			{ length: count },
			() => null,
		);
		let done = 0;

		tx.onerror = () => {
			db.close();
			reject(tx.error);
		};

		for (let i = 0; i < count; i++) {
			const idx = i;
			const req = store.get(`${sessionId}:${idx}`);
			req.onsuccess = () => {
				// Avoid `instanceof Blob` — fake-indexeddb's structured-clone may
				// return a Node.js Blob rather than jsdom's, so the check fails across
				// realms. Treat any truthy result as a Blob.
				results[idx] = req.result != null ? (req.result as Blob) : null;
				done++;
				if (done === count) {
					db.close();
					resolve(results);
				}
			};
			req.onerror = () => {
				done++;
				if (done === count) {
					db.close();
					resolve(results);
				}
			};
		}
	});
}

/**
 * Delete all blobs stored for a session (keys `${sessionId}:0` …
 * `${sessionId}:\uffff` covers any numeric index suffix).
 */
export async function clearShots(sessionId: string): Promise<void> {
	if (typeof indexedDB === "undefined") return;
	const db = await openDb();
	return new Promise<void>((resolve, reject) => {
		const tx = db.transaction(IDB_STORE, "readwrite");
		tx.oncomplete = () => {
			db.close();
			resolve();
		};
		tx.onerror = () => {
			db.close();
			reject(tx.error);
		};
		const range = IDBKeyRange.bound(`${sessionId}:`, `${sessionId}:\uffff`);
		tx.objectStore(IDB_STORE).delete(range);
	});
}

// ---------------------------------------------------------------------------
// High-level clear
// ---------------------------------------------------------------------------

/** Remove both the lightweight localStorage entry and all IndexedDB blobs. */
export async function clearSession(sessionId: string): Promise<void> {
	removeSession();
	await clearShots(sessionId);
}
