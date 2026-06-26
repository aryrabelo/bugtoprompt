/**
 * Client-side, encrypted-at-rest persistence for the AssemblyAI API key.
 *
 * The long-lived key lives ONLY in this browser and is never sent to any
 * first-party server. At rest it is stored ENCRYPTED in localStorage:
 *
 *   - A 256-bit AES-GCM key is generated ONCE as a non-extractable CryptoKey
 *     and persisted in IndexedDB (CryptoKey objects are structured-cloneable,
 *     so the raw bytes never leave the browser's crypto engine).
 *   - The API key is encrypted with that CryptoKey and stored as
 *     base64(iv ++ ciphertext) in localStorage.
 *
 * A cookie is intentionally NOT used: it would auto-attach to every request to
 * the page origin, leaking the secret. localStorage + WebCrypto keeps the key
 * client-only and unreadable at rest. (Honest limitation: same-origin script
 * can still call decrypt — inherent to any browser-held secret.)
 *
 * Every window / localStorage / indexedDB / crypto.subtle access is guarded for
 * SSR / jsdom and wrapped in try/catch, so importing this module never throws
 * and these functions never throw in a non-browser environment. On any
 * storage / crypto failure they degrade to an in-memory cache so the current
 * tab keeps working.
 */

const STORAGE_KEY_ENC = "bugtoprompt:assemblyai-key:enc";
const STORAGE_KEY_LEGACY = "bugtoprompt:assemblyai-key";

const DB_NAME = "bugtoprompt-keys";
const STORE_NAME = "crypto-keys";
const CRYPTO_KEY_ID = "assemblyai-aes-gcm-v1";
const IV_BYTES = 12;

/** In-memory copy of the decrypted key for this tab (survives storage failure). */
let memoryKey: string | undefined;

// ---------------------------------------------------------------------------
// base64 <-> bytes
// ---------------------------------------------------------------------------

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

// ---------------------------------------------------------------------------
// IndexedDB helpers (promisified, single-store key/value)
// ---------------------------------------------------------------------------

function openDb(): Promise<IDBDatabase> {
	return new Promise<IDBDatabase>((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, 1);
		req.onupgradeneeded = (): void => {
			const db = req.result;
			if (!db.objectStoreNames.contains(STORE_NAME)) {
				db.createObjectStore(STORE_NAME);
			}
		};
		req.onsuccess = (): void => resolve(req.result);
		req.onerror = (): void => reject(req.error);
	});
}

async function idbGet<T>(key: string): Promise<T | undefined> {
	const db = await openDb();
	try {
		return await new Promise<T | undefined>((resolve, reject) => {
			const tx = db.transaction(STORE_NAME, "readonly");
			const req = tx.objectStore(STORE_NAME).get(key);
			req.onsuccess = (): void => resolve(req.result as T | undefined);
			req.onerror = (): void => reject(req.error);
		});
	} finally {
		db.close();
	}
}

async function idbPut(key: string, value: unknown): Promise<void> {
	const db = await openDb();
	try {
		await new Promise<void>((resolve, reject) => {
			const tx = db.transaction(STORE_NAME, "readwrite");
			tx.objectStore(STORE_NAME).put(value, key);
			tx.oncomplete = (): void => resolve();
			tx.onerror = (): void => reject(tx.error);
			tx.onabort = (): void => reject(tx.error);
		});
	} finally {
		db.close();
	}
}

async function idbDelete(key: string): Promise<void> {
	const db = await openDb();
	try {
		await new Promise<void>((resolve, reject) => {
			const tx = db.transaction(STORE_NAME, "readwrite");
			tx.objectStore(STORE_NAME).delete(key);
			tx.oncomplete = (): void => resolve();
			tx.onerror = (): void => reject(tx.error);
			tx.onabort = (): void => reject(tx.error);
		});
	} finally {
		db.close();
	}
}

/** Fetch the persisted AES-GCM CryptoKey, generating + storing one on first use. */
async function getOrCreateCryptoKey(): Promise<CryptoKey> {
	const existing = await idbGet<CryptoKey>(CRYPTO_KEY_ID);
	if (existing) return existing;
	const key = await crypto.subtle.generateKey(
		{ name: "AES-GCM", length: 256 },
		false, // non-extractable: raw bytes never leave the crypto engine.
		["encrypt", "decrypt"],
	);
	await idbPut(CRYPTO_KEY_ID, key);
	return key;
}

// ---------------------------------------------------------------------------
// loadAssemblyKey helpers
// ---------------------------------------------------------------------------

/**
 * If a legacy plaintext key exists in localStorage, migrate it to the
 * encrypted form and remove the plaintext entry. Returns the migrated key
 * string, or null when there is nothing to migrate.
 */
async function migrateLegacyKey(): Promise<string | null> {
	try {
		const legacy = localStorage.getItem(STORAGE_KEY_LEGACY);
		if (legacy === null) return null;
		const trimmed = legacy.trim();
		if (trimmed) {
			await saveAssemblyKey(trimmed);
			try {
				localStorage.removeItem(STORAGE_KEY_LEGACY);
			} catch {
				// ignore — best-effort cleanup.
			}
			return trimmed;
		}
		// Empty legacy value — discard it.
		try {
			localStorage.removeItem(STORAGE_KEY_LEGACY);
		} catch {
			// ignore.
		}
		return null;
	} catch {
		// localStorage unreadable — fall through.
		return null;
	}
}

/**
 * Decrypt the encrypted localStorage blob using the IndexedDB CryptoKey.
 * Returns the plaintext key, or undefined when unavailable.
 */
async function decryptStoredKey(): Promise<string | undefined> {
	try {
		const blob = localStorage.getItem(STORAGE_KEY_ENC);
		const hasCrypto =
			typeof crypto !== "undefined" &&
			typeof crypto.subtle !== "undefined" &&
			typeof indexedDB !== "undefined";
		if (!blob || !hasCrypto) return undefined;
		const bytes = base64ToBytes(blob);
		if (bytes.length <= IV_BYTES) return undefined;
		const iv = bytes.slice(0, IV_BYTES);
		const ciphertext = bytes.slice(IV_BYTES);
		const cryptoKey = await idbGet<CryptoKey>(CRYPTO_KEY_ID);
		if (!cryptoKey) return undefined;
		const plain = await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv },
			cryptoKey,
			ciphertext,
		);
		const decoded = new TextDecoder().decode(plain).trim();
		return decoded || undefined;
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve the decrypted AssemblyAI key, or undefined when none / unavailable.
 *
 * Source order: (a) in-memory cache, (b) `window.__BUGTOPROMPT__.assemblyAiKey`
 * (host-injected hint, read-only), (c) the encrypted localStorage blob
 * decrypted via the IndexedDB CryptoKey.
 * A legacy plaintext key is transparently migrated to the encrypted form.
 * Empty / whitespace values count as no key. The resolved key is cached in
 * memory for this tab's lifetime.
 */
export async function loadAssemblyKey(): Promise<string | undefined> {
	// (a) In-memory cache (already trimmed when set).
	if (memoryKey) return memoryKey;

	if (typeof window === "undefined") return undefined;

	// (b) Window hint (host-injected — read only, never written back).
	const winKey = window.__BUGTOPROMPT__?.assemblyAiKey?.trim();
	if (winKey) {
		memoryKey = winKey;
		return winKey;
	}

	if (typeof localStorage === "undefined") return undefined;

	// (c) Migration: a legacy plaintext key is upgraded to the encrypted form.
	const migrated = await migrateLegacyKey();
	if (migrated !== null) return migrated;

	// (d) Decrypt the encrypted blob.
	const decrypted = await decryptStoredKey();
	if (decrypted) {
		memoryKey = decrypted;
	}
	return decrypted;
}

/**
 * Persist the AssemblyAI key (trimmed), encrypted at rest. Empty / whitespace
 * is NEVER stored. The in-memory cache is set first so the current tab works
 * even when crypto / IndexedDB / localStorage are unavailable (graceful
 * degrade). The key is NEVER written to window — the IndexedDB store is the
 * sole source of truth.
 */
export async function saveAssemblyKey(key: string): Promise<void> {
	const t = key.trim();
	if (!t) return;

	// Degrade-safe: set the in-memory copy before touching persistent storage.
	memoryKey = t;

	if (typeof window === "undefined" || typeof localStorage === "undefined") {
		return;
	}
	if (
		typeof crypto === "undefined" ||
		typeof crypto.subtle === "undefined" ||
		typeof indexedDB === "undefined"
	) {
		return;
	}

	try {
		const cryptoKey = await getOrCreateCryptoKey();
		const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
		const ciphertext = await crypto.subtle.encrypt(
			{ name: "AES-GCM", iv },
			cryptoKey,
			new TextEncoder().encode(t),
		);
		const ct = new Uint8Array(ciphertext);
		const combined = new Uint8Array(iv.length + ct.length);
		combined.set(iv, 0);
		combined.set(ct, iv.length);
		localStorage.setItem(STORAGE_KEY_ENC, bytesToBase64(combined));
	} catch {
		// Crypto / storage failure — the memory cache above keeps this tab
		// functional for the session.
	}
}

/**
 * Remove the stored key everywhere: the encrypted (and legacy) localStorage
 * blobs, the IndexedDB CryptoKey, the in-memory cache, and any host-injected
 * window hint.
 */
export async function clearAssemblyKey(): Promise<void> {
	memoryKey = undefined;

	if (typeof window !== "undefined") {
		if (window.__BUGTOPROMPT__) {
			delete window.__BUGTOPROMPT__.assemblyAiKey;
		}
		if (typeof localStorage !== "undefined") {
			try {
				localStorage.removeItem(STORAGE_KEY_ENC);
				localStorage.removeItem(STORAGE_KEY_LEGACY);
			} catch {
				// ignore — nothing to clear if storage is unavailable.
			}
		}
	}

	if (typeof indexedDB !== "undefined") {
		try {
			await idbDelete(CRYPTO_KEY_ID);
		} catch {
			// ignore — nothing to clear if IndexedDB is unavailable.
		}
	}
}

/**
 * SYNC check for a usable streaming credential for this tab. Does NOT decrypt.
 * True iff a window-level streaming token or AssemblyAI key is set (host hint),
 * a non-empty encrypted blob exists in localStorage, or the in-memory cache
 * is populated.
 */
export function hasStoredKey(): boolean {
	if (memoryKey) return true;

	if (typeof window !== "undefined") {
		const hint = window.__BUGTOPROMPT__;
		if (
			(typeof hint?.streamingToken === "string" &&
				hint.streamingToken !== "") ||
			(typeof hint?.assemblyAiKey === "string" && hint.assemblyAiKey !== "")
		)
			return true;
		if (typeof localStorage !== "undefined") {
			try {
				const blob = localStorage.getItem(STORAGE_KEY_ENC);
				if (blob !== null && blob !== "") return true;
			} catch {
				// ignore — treat unreadable storage as no key.
			}
		}
	}

	return false;
}

/** Alias of {@link hasStoredKey} kept for callers importing the old name. */
export function hasConfiguredKey(): boolean {
	return hasStoredKey();
}
