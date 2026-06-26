import { beforeEach, describe, expect, it } from "vitest";
import {
	clearAssemblyKey,
	hasConfiguredKey,
	hasStoredKey,
	loadAssemblyKey,
	saveAssemblyKey,
} from "./key-store";

const STORAGE_KEY_ENC = "bugtoprompt:assemblyai-key:enc";
const STORAGE_KEY_LEGACY = "bugtoprompt:assemblyai-key";

beforeEach(async () => {
	localStorage.clear();
	delete window.__BUGTOPROMPT__;
	// Reset the module-level in-memory cache + IndexedDB CryptoKey.
	await clearAssemblyKey();
	localStorage.clear();
	delete window.__BUGTOPROMPT__;
});

describe("key-store", () => {
	it("save → load roundtrip returns the exact key", async () => {
		await saveAssemblyKey("my-key");
		expect(await loadAssemblyKey()).toBe("my-key");
	});

	it("encrypts at rest: the localStorage blob is not the plaintext", async () => {
		await saveAssemblyKey("my-secret-key");
		const blob = localStorage.getItem(STORAGE_KEY_ENC);
		expect(blob).not.toBeNull();
		expect(blob).not.toContain("my-secret-key");
	});

	it("saveAssemblyKey does NOT write the key to window (security: C2)", async () => {
		await saveAssemblyKey("top-secret");
		expect(window.__BUGTOPROMPT__?.assemblyAiKey).toBeUndefined();
	});

	it("save → load roundtrip (trimmed)", async () => {
		await saveAssemblyKey("  spacey  ");
		expect(await loadAssemblyKey()).toBe("spacey");
	});

	it("empty / whitespace save is a no-op: nothing stored", async () => {
		await saveAssemblyKey("   ");
		expect(localStorage.getItem(STORAGE_KEY_ENC)).toBeNull();
		expect(hasStoredKey()).toBe(false);
		expect(await loadAssemblyKey()).toBeUndefined();
	});

	it("clearAssemblyKey removes the blob and clears state", async () => {
		await saveAssemblyKey("gone");
		await clearAssemblyKey();
		expect(localStorage.getItem(STORAGE_KEY_ENC)).toBeNull();
		expect(hasStoredKey()).toBe(false);
		expect(await loadAssemblyKey()).toBeUndefined();
	});

	it("loadAssemblyKey returns undefined when nothing stored (no throw)", async () => {
		expect(await loadAssemblyKey()).toBeUndefined();
	});

	it("hasStoredKey: true after a save", async () => {
		await saveAssemblyKey("stored");
		expect(hasStoredKey()).toBe(true);
	});

	it("hasStoredKey: true when window.assemblyAiKey is set", () => {
		window.__BUGTOPROMPT__ = { assemblyAiKey: "w" };
		expect(hasStoredKey()).toBe(true);
	});

	it("hasStoredKey: true when window.streamingToken is set", () => {
		window.__BUGTOPROMPT__ = { streamingToken: "t" };
		expect(hasStoredKey()).toBe(true);
	});

	it("hasStoredKey: false when nothing is configured", () => {
		expect(hasStoredKey()).toBe(false);
	});

	it("hasConfiguredKey is an alias of hasStoredKey", async () => {
		expect(hasConfiguredKey()).toBe(false);
		await saveAssemblyKey("alias");
		expect(hasConfiguredKey()).toBe(true);
	});

	it("migrates a legacy plaintext key to the encrypted form", async () => {
		localStorage.setItem(STORAGE_KEY_LEGACY, "legacy");

		expect(await loadAssemblyKey()).toBe("legacy");

		// Legacy plaintext is gone; an encrypted blob now exists.
		expect(localStorage.getItem(STORAGE_KEY_LEGACY)).toBeNull();
		const enc = localStorage.getItem(STORAGE_KEY_ENC);
		expect(enc).not.toBeNull();
		expect(enc).not.toContain("legacy");
	});

	it("discards an empty legacy plaintext value", async () => {
		localStorage.setItem(STORAGE_KEY_LEGACY, "   ");
		expect(await loadAssemblyKey()).toBeUndefined();
		expect(localStorage.getItem(STORAGE_KEY_LEGACY)).toBeNull();
		expect(localStorage.getItem(STORAGE_KEY_ENC)).toBeNull();
	});
});
