/**
 * jsdom roundtrip tests for the MAIN-world PRO bridge client, wire contract
 * v2 (issue #82, findings 2+4). A fake relay stands in for the extension's
 * content script + service worker: it answers every `btp:pro-request` with a
 * scripted `btp:pro-response`, dispatched as a real `message` event so the
 * client's `window.addEventListener("message", ...)` handling is exercised
 * for real.
 *
 * The outbound leg is intercepted via a `window.postMessage` spy rather than
 * relying on jsdom to self-deliver the post — jsdom does not implement the
 * `targetOrigin: "/"` case the client uses (real browsers treat "/" as "use
 * the document's own origin"; jsdom silently drops it), so a real
 * `postMessage(msg, "/")` never reaches this same window in tests. The spy
 * still asserts the client posted exactly the contract-shaped request.
 *
 * The legacy-plaintext suite below imports `createProBridgeClient` statically
 * and never calls `window.__btpProBridgeSecret.set()` against that module
 * instance — so it runs in degraded/no-secret mode explicitly, by
 * construction, regardless of whether this jsdom process happens to expose
 * `crypto.subtle`. The contract-v2 suite needs the opposite: a *fresh*
 * `bridgeSecret` per test. Since that's module-scope state (by design — see
 * pro-bridge.ts), the only way to reset it between tests is a fresh module
 * instance, via `vi.resetModules()` + a dynamic `import()` (the same pattern
 * `standalone.test.ts` uses for its own module-load-order test).
 */
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Target } from "./index";
import { createProBridgeClient } from "./pro-bridge";

// jsdom does not implement SubtleCrypto. Node's own webcrypto is available
// globally in this Vitest/Node process but jsdom's environment swap can
// leave `crypto.subtle` undefined; back it with Node's webcrypto in that
// case. A plain descriptor swap (not `vi.stubGlobal`) so this polyfill isn't
// undone by any individual test's `vi.restoreAllMocks()`/`unstubAllGlobals()`.
if (typeof crypto === "undefined" || !crypto.subtle) {
	Object.defineProperty(globalThis, "crypto", {
		value: webcrypto,
		configurable: true,
		writable: true,
	});
}

// ---------------------------------------------------------------------------
// Legacy (v1) plaintext message shapes + relay
// ---------------------------------------------------------------------------

interface ProRequestMessage {
	type: "btp:pro-request";
	id: string;
	op: string;
	payload: unknown;
}

function isProRequest(data: unknown): data is ProRequestMessage {
	return (
		typeof data === "object" &&
		data !== null &&
		"type" in data &&
		data.type === "btp:pro-request" &&
		"op" in data
	);
}

/** Install a fake relay answering every request via `respond`, dispatched as
 *  a real `message` event (source: window) — the same shape the extension's
 *  relay content script produces. Captures each request for assertions. */
function installRelay(
	respond: (
		op: string,
		payload: unknown,
	) => { ok: true; result: unknown } | { ok: false; error: string },
	onRequest?: (msg: ProRequestMessage) => void,
): void {
	vi.spyOn(window, "postMessage").mockImplementation((message: unknown) => {
		if (!isProRequest(message)) return;
		onRequest?.(message);
		const outcome = respond(message.op, message.payload);
		window.dispatchEvent(
			new MessageEvent("message", {
				data: { type: "btp:pro-response", id: message.id, ...outcome },
				source: window,
			}),
		);
	});
}

// ---------------------------------------------------------------------------
// Contract v2 encrypted message shapes + crypto (independent of pro-bridge.ts
// internals — mirrors the wire contract exactly, the same way a real
// extension relay implementation would).
// ---------------------------------------------------------------------------

interface Envelope {
	iv: string;
	data: string;
}

// Contract v2.1 3a: encrypted-mode request ids are crypto.randomUUID().
const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ProEncryptedRequestMessage {
	type: "btp:pro-request";
	id: string;
	enc: Envelope;
}

function isEncReq(data: unknown): data is ProEncryptedRequestMessage {
	return (
		typeof data === "object" &&
		data !== null &&
		"type" in data &&
		data.type === "btp:pro-request" &&
		"enc" in data
	);
}

function toB64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function fromB64(b64: string): Uint8Array<ArrayBuffer> {
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

async function deriveTestKey(secret: string): Promise<CryptoKey> {
	const raw = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(secret),
	);
	return crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
		"encrypt",
		"decrypt",
	]);
}

async function encryptFor(
	key: CryptoKey,
	plaintext: string,
	aad: string,
): Promise<Envelope> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ct = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) },
		key,
		new TextEncoder().encode(plaintext),
	);
	return { iv: toB64(iv), data: toB64(new Uint8Array(ct)) };
}

async function decryptWith(
	key: CryptoKey,
	enc: Envelope,
	aad: string,
): Promise<string> {
	const pt = await crypto.subtle.decrypt(
		{
			name: "AES-GCM",
			iv: fromB64(enc.iv),
			additionalData: new TextEncoder().encode(aad),
		},
		key,
		fromB64(enc.data),
	);
	return new TextDecoder().decode(pt);
}

/** Install a fake v2 (encrypted) relay: decrypts every outbound request
 *  under `secret`'s derived key with the contract v2.1 `"btp:req:"+id` AAD,
 *  calls `respond`, and dispatches the encrypted reply — sealed with the
 *  `"btp:res:"+id` AAD — as a real `message` event — the same shape the
 *  extension's ISOLATED-world relay produces. Requests that fail to decrypt
 *  under `secret`/the expected AAD are dropped (mirrors the real relay's
 *  "garbage in, silence out" behavior) rather than crashing the test. */
function installEncryptedRelay(
	secret: string,
	respond: (
		op: string,
		payload: unknown,
	) => { ok: true; result: unknown } | { ok: false; error: string },
	onRequest?: (
		op: string,
		payload: unknown,
		wire: ProEncryptedRequestMessage,
	) => void,
): void {
	const keyPromise = deriveTestKey(secret);
	vi.spyOn(window, "postMessage").mockImplementation((message: unknown) => {
		if (!isEncReq(message)) return;
		void (async () => {
			const key = await keyPromise;
			let op: string;
			let payload: unknown;
			try {
				const parsed: unknown = JSON.parse(
					await decryptWith(key, message.enc, `btp:req:${message.id}`),
				);
				if (
					!parsed ||
					typeof parsed !== "object" ||
					!("op" in parsed) ||
					typeof parsed.op !== "string"
				) {
					return;
				}
				op = parsed.op;
				payload = "payload" in parsed ? parsed.payload : undefined;
			} catch {
				return;
			}
			onRequest?.(op, payload, message);
			const outcome = respond(op, payload);
			const enc = await encryptFor(
				key,
				JSON.stringify(outcome),
				`btp:res:${message.id}`,
			);
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "btp:pro-response", id: message.id, enc },
					source: window,
				}),
			);
		})();
	});
}

/** Fresh module instance of pro-bridge.ts, so `bridgeSecret` (module-scope,
 *  by design) starts unset regardless of what earlier tests did. Re-runs the
 *  module's top-level `window.__btpProBridgeSecret = { set(...) }`
 *  registration, so `setSecret` below always targets the returned client's
 *  own module instance — never a sibling test's. */
async function freshBridgeModule(): Promise<{
	createProBridgeClient: typeof createProBridgeClient;
	setSecret: (secret: string) => void;
}> {
	vi.resetModules();
	// Exception to ts-no-dynamic-import: module-loading boundary test — the
	// module specifier is static, but we deliberately re-evaluate the module
	// fresh so its module-scope `bridgeSecret` starts unset (mirrors
	// standalone.test.ts's own resetModules()+dynamic-import pattern).
	const mod = await import("./pro-bridge");
	const setter = window.__btpProBridgeSecret;
	if (!setter) {
		throw new Error(
			"pro-bridge.ts did not register window.__btpProBridgeSecret",
		);
	}
	return {
		createProBridgeClient: mod.createProBridgeClient,
		setSecret: (secret: string) => setter.set(secret),
	};
}

/** Real wall-clock wait. Exception to ts-no-test-timers: proving the
 *  client's promise does *not* settle on a forged response has no event to
 *  await — there is no "nothing happened" signal — so a short, bounded
 *  delay is the only way to assert that negative. Kept short and used once. */
function wait(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("createProBridgeClient (P0 fix, issue #82) — legacy v1 plaintext relay, degraded/no-secret mode", () => {
	// Contract v2.1 3b reserves the plaintext relay for contexts that
	// genuinely lack `crypto.subtle` — "subtle present, no secret" now
	// fails closed instead of falling back here (see the fail-closed tests
	// below). So this suite must actually remove `crypto.subtle` to
	// exercise the degraded path for real, using the same swap-and-restore
	// technique as the top-of-file webcrypto polyfill.
	let originalCrypto: Crypto;

	beforeEach(() => {
		originalCrypto = globalThis.crypto;
		Object.defineProperty(globalThis, "crypto", {
			value: {
				getRandomValues: originalCrypto.getRandomValues.bind(originalCrypto),
			},
			configurable: true,
			writable: true,
		});
	});

	afterEach(() => {
		Object.defineProperty(globalThis, "crypto", {
			value: originalCrypto,
			configurable: true,
			writable: true,
		});
	});

	it('mintStreamingToken posts op "mintStreamingToken" and resolves with the relayed result', async () => {
		let capturedOp: string | undefined;
		let capturedPayload: unknown;
		installRelay(
			() => ({ ok: true, result: { token: "tok", expiresAt: 999 } }),
			(msg) => {
				capturedOp = msg.op;
				capturedPayload = msg.payload;
			},
		);

		const result = await createProBridgeClient().mintStreamingToken("t1");

		expect(capturedOp).toBe("mintStreamingToken");
		expect(capturedPayload).toEqual({ targetId: "t1" });
		expect(result).toEqual({ token: "tok", expiresAt: 999 });
	});

	it("rejects when the relay responds ok:false, with the relayed error message", async () => {
		installRelay(() => ({ ok: false, error: "no PRO subscription" }));

		await expect(createProBridgeClient().listTargets("p1")).rejects.toThrow(
			"no PRO subscription",
		);
	});

	it("saveArtifact rejects locally without posting anything — capture bytes must never leave the page plaintext", async () => {
		const postSpy = vi.spyOn(window, "postMessage");

		await expect(
			createProBridgeClient().saveArtifact({
				artifact: { sessionId: "s1" } as never,
				audioBase64: "aa",
				screenshotsBase64: ["bb"],
			}),
		).rejects.toThrow(/refusing to send capture bytes/);

		expect(postSpy).not.toHaveBeenCalled();
	});

	it("transcribeBatch/createIssue/listTargets post the exact contract op + payload", async () => {
		const seen: { op: string; payload: unknown }[] = [];
		installRelay(
			() => ({ ok: true, result: {} }),
			(msg) => seen.push({ op: msg.op, payload: msg.payload }),
		);
		const client = createProBridgeClient();

		await client.transcribeBatch("s1", "t1");
		await client.createIssue({ sessionId: "s1", prompt: "p" });
		await client.listTargets("proj-1");

		expect(seen).toEqual([
			{ op: "transcribeBatch", payload: { sessionId: "s1", targetId: "t1" } },
			{ op: "createIssue", payload: { sessionId: "s1", prompt: "p" } },
			{ op: "listTargets", payload: { projectId: "proj-1" } },
		]);
	});

	it("listTargets resolves the relayed result as Target[]", async () => {
		const targets: Target[] = [{ id: "t1", name: "main", branch: "main" }];
		installRelay(() => ({ ok: true, result: targets }));

		await expect(createProBridgeClient().listTargets("p1")).resolves.toEqual(
			targets,
		);
	});

	it("matches concurrent requests to their own response by id (no cross-talk)", async () => {
		installRelay((_op, payload) => {
			const targetId =
				payload && typeof payload === "object" && "targetId" in payload
					? payload.targetId
					: undefined;
			return { ok: true, result: { token: `tok-${targetId}`, expiresAt: 0 } };
		});
		const client = createProBridgeClient();

		const [a, b] = await Promise.all([
			client.mintStreamingToken("a"),
			client.mintStreamingToken("b"),
		]);

		expect(a).toEqual({ token: "tok-a", expiresAt: 0 });
		expect(b).toEqual({ token: "tok-b", expiresAt: 0 });
	});

	it("removes its message listener once the request settles — no leaked/duplicate handling", async () => {
		installRelay(() => ({ ok: true, result: { token: "tok", expiresAt: 0 } }));
		const addSpy = vi.spyOn(window, "addEventListener");
		const removeSpy = vi.spyOn(window, "removeEventListener");

		await createProBridgeClient().mintStreamingToken();

		const adds = addSpy.mock.calls.filter(
			([type]) => type === "message",
		).length;
		const removes = removeSpy.mock.calls.filter(
			([type]) => type === "message",
		).length;
		expect(adds).toBe(1);
		expect(removes).toBe(1);
	});
});

describe("createProBridgeClient — contract v2 encrypted relay", () => {
	it("encrypted round trip: the wire request carries only `enc` (no plaintext op/payload); response resolves with the relayed result", async () => {
		const { createProBridgeClient, setSecret } = await freshBridgeModule();
		const secret = "secret-A";
		setSecret(secret);

		let capturedOp: string | undefined;
		let capturedPayload: unknown;
		let wire: ProEncryptedRequestMessage | undefined;
		installEncryptedRelay(
			secret,
			() => ({ ok: true, result: { token: "tok-v2", expiresAt: 111 } }),
			(op, payload, msg) => {
				capturedOp = op;
				capturedPayload = payload;
				wire = msg;
			},
		);

		const result = await createProBridgeClient().mintStreamingToken("t1");

		expect(capturedOp).toBe("mintStreamingToken");
		expect(capturedPayload).toEqual({ targetId: "t1" });
		expect(result).toEqual({ token: "tok-v2", expiresAt: 111 });
		expect(wire?.enc).toBeTruthy();
		expect(wire?.id).toMatch(UUID_RE);
		expect(wire).not.toHaveProperty("op");
		expect(wire).not.toHaveProperty("payload");
	});

	it("ignores a plaintext-shaped forged response and an enc response under the wrong key — only the genuine encrypted reply resolves the request", async () => {
		const { createProBridgeClient, setSecret } = await freshBridgeModule();
		const secret = "secret-B";
		setSecret(secret);

		let capturedId: string | undefined;
		vi.spyOn(window, "postMessage").mockImplementation((message: unknown) => {
			if (isEncReq(message)) capturedId = message.id;
		});

		const pending = createProBridgeClient().mintStreamingToken("t1");
		await vi.waitFor(() => {
			expect(capturedId).toBeDefined();
		});
		if (capturedId === undefined) {
			throw new Error("encrypted request id was never captured");
		}
		const id = capturedId;

		let settled = false;
		pending.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);

		// (a) plaintext-shaped forged response, correct id — ignored in
		// encrypted mode because it has no `enc` field.
		window.dispatchEvent(
			new MessageEvent("message", {
				data: {
					type: "btp:pro-response",
					id,
					ok: true,
					result: { evil: "plaintext" },
				},
				source: window,
			}),
		);

		// (b) enc response encrypted under a DIFFERENT key, correct id —
		// decrypts to garbage/fails auth and is dropped.
		const wrongKey = await deriveTestKey("a-completely-different-secret");
		const forgedEnc = await encryptFor(
			wrongKey,
			JSON.stringify({ ok: true, result: { evil: "wrong-key" } }),
			`btp:res:${id}`,
		);
		window.dispatchEvent(
			new MessageEvent("message", {
				data: { type: "btp:pro-response", id, enc: forgedEnc },
				source: window,
			}),
		);

		await wait(50);
		expect(settled).toBe(false);

		// (c) the genuine encrypted response, same id, correct key — resolves.
		const key = await deriveTestKey(secret);
		const genuineEnc = await encryptFor(
			key,
			JSON.stringify({ ok: true, result: { token: "real-tok", expiresAt: 1 } }),
			`btp:res:${id}`,
		);
		window.dispatchEvent(
			new MessageEvent("message", {
				data: { type: "btp:pro-response", id, enc: genuineEnc },
				source: window,
			}),
		);

		await expect(pending).resolves.toEqual({
			token: "real-tok",
			expiresAt: 1,
		});
	});

	it("saveArtifact (encrypted mode): the wire message contains neither the audio nor screenshot base64 bytes", async () => {
		const { createProBridgeClient, setSecret } = await freshBridgeModule();
		const secret = "secret-C";
		setSecret(secret);

		let wireJson: string | undefined;
		installEncryptedRelay(
			secret,
			() => ({ ok: true, result: { dir: "d", sessionId: "s1" } }),
			(_op, _payload, wire) => {
				wireJson = JSON.stringify(wire);
			},
		);

		await createProBridgeClient().saveArtifact({
			artifact: { sessionId: "s1" } as never,
			audioBase64: "AUDIO_MARKER_BASE64_BYTES",
			screenshotsBase64: ["SCREENSHOT_MARKER_BASE64_BYTES"],
		});

		if (wireJson === undefined) {
			throw new Error("wire message was never captured");
		}
		expect(wireJson).not.toContain("AUDIO_MARKER_BASE64_BYTES");
		expect(wireJson).not.toContain("SCREENSHOT_MARKER_BASE64_BYTES");
	});

	it("saveArtifact (degraded mode, no crypto.subtle): rejects locally without ever posting the payload", async () => {
		const { createProBridgeClient, setSecret } = await freshBridgeModule();
		setSecret("secret-D"); // a delivered secret alone isn't enough without subtle.

		const originalCrypto = globalThis.crypto;
		Object.defineProperty(globalThis, "crypto", {
			value: {
				getRandomValues: originalCrypto.getRandomValues.bind(originalCrypto),
			},
			configurable: true,
			writable: true,
		});
		try {
			const postSpy = vi.spyOn(window, "postMessage");

			await expect(
				createProBridgeClient().saveArtifact({
					artifact: { sessionId: "s1" } as never,
					audioBase64: "aa",
					screenshotsBase64: ["bb"],
				}),
			).rejects.toThrow(/refusing to send capture bytes/);

			expect(postSpy).not.toHaveBeenCalled();
		} finally {
			Object.defineProperty(globalThis, "crypto", {
				value: originalCrypto,
				configurable: true,
				writable: true,
			});
		}
	});

	it('secret setter hygiene: set("") is ignored — subsequent requests fail closed (subtle present, no secret), never falling back to plaintext', async () => {
		const { createProBridgeClient, setSecret } = await freshBridgeModule();
		setSecret("");

		const postSpy = vi.spyOn(window, "postMessage");

		await expect(createProBridgeClient().listTargets("p1")).rejects.toThrow(
			/encryption secret not established/,
		);
		expect(postSpy).not.toHaveBeenCalled();
	});

	it("secret setter hygiene: setting a new secret replaces the old one for subsequent requests", async () => {
		const { createProBridgeClient, setSecret } = await freshBridgeModule();

		setSecret("secret-old");
		installEncryptedRelay("secret-old", () => ({
			ok: true,
			result: { round: 1 },
		}));
		await expect(createProBridgeClient().listTargets("p1")).resolves.toEqual({
			round: 1,
		});
		vi.restoreAllMocks();

		// A relay keyed to the NEW secret only succeeds if the client actually
		// re-derived its key — a stale cached key from "secret-old" would fail
		// to decrypt against this relay and the request would never resolve.
		setSecret("secret-new");
		installEncryptedRelay("secret-new", () => ({
			ok: true,
			result: { round: 2 },
		}));
		await expect(createProBridgeClient().listTargets("p1")).resolves.toEqual({
			round: 2,
		});
	});
});

describe("createProBridgeClient — contract v2.1: AAD id+direction binding, fail-closed", () => {
	it("ignores a response rebound to a different request's id (same key, wrong AAD) — only the AAD-correct response resolves", async () => {
		const { createProBridgeClient, setSecret } = await freshBridgeModule();
		const secret = "secret-rebind";
		setSecret(secret);

		let capturedId: string | undefined;
		vi.spyOn(window, "postMessage").mockImplementation((message: unknown) => {
			if (isEncReq(message)) capturedId = message.id;
		});

		const pending = createProBridgeClient().mintStreamingToken("t1");
		await vi.waitFor(() => {
			expect(capturedId).toBeDefined();
		});
		if (capturedId === undefined) {
			throw new Error("encrypted request id was never captured");
		}
		const id = capturedId;
		expect(id).toMatch(UUID_RE);

		let settled = false;
		pending.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);

		// Encrypted under the correct key and posted under the real wire id
		// (so it passes the id filter) — but bound to a DIFFERENT response's
		// AAD ("btp:res:some-other-id"). This is the rebind attack: a
		// genuine response recorded from one exchange and replayed onto this
		// one's id. Pre-AAD, this would have decrypted cleanly under the
		// shared key and resolved the wrong request; with AAD binding, GCM
		// authentication fails because the AAD doesn't match the id it's
		// posted under, so it must be dropped like any other forgery.
		const key = await deriveTestKey(secret);
		const reboundEnc = await encryptFor(
			key,
			JSON.stringify({ ok: true, result: { evil: "rebound" } }),
			"btp:res:some-other-id",
		);
		window.dispatchEvent(
			new MessageEvent("message", {
				data: { type: "btp:pro-response", id, enc: reboundEnc },
				source: window,
			}),
		);

		await wait(50);
		expect(settled).toBe(false);

		// The genuine AAD-correct response (same id, matching "btp:res:"+id
		// AAD) resolves normally.
		const genuineEnc = await encryptFor(
			key,
			JSON.stringify({ ok: true, result: { token: "real-tok", expiresAt: 1 } }),
			`btp:res:${id}`,
		);
		window.dispatchEvent(
			new MessageEvent("message", {
				data: { type: "btp:pro-response", id, enc: genuineEnc },
				source: window,
			}),
		);

		await expect(pending).resolves.toEqual({
			token: "real-tok",
			expiresAt: 1,
		});
	});

	it("fails closed when crypto.subtle is present but no secret has been delivered — createIssue and transcribeBatch reject locally without ever posting a payload", async () => {
		const { createProBridgeClient } = await freshBridgeModule();
		// No setSecret() call: bridgeSecret stays unset on this fresh module
		// instance, while crypto.subtle stays present (the ambient jsdom
		// crypto forced at the top of this file, untouched by this suite).

		const postSpy = vi.spyOn(window, "postMessage");
		const client = createProBridgeClient();

		await expect(
			client.createIssue({ sessionId: "s1", prompt: "p" }),
		).rejects.toThrow(/encryption secret not established/);
		await expect(client.transcribeBatch("s1", "t1")).rejects.toThrow(
			/encryption secret not established/,
		);

		expect(postSpy).not.toHaveBeenCalled();
	});
});
