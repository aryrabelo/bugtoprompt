/**
 * MV3 service worker. Owns per-tab activation state and injects the packaged
 * standalone overlay bundle (never a second React app). All Chrome API access
 * is behind functions that accept an injected `chrome`-like object so the core
 * logic is unit-testable with a mocked `chrome`.
 */

import type { ChromeLike, SyncConfig } from "./config";
import {
	candidateBaseUrls,
	classifyPage,
	discoverBaseUrl,
	loadConfig,
	originPattern,
	PRO_BASE_URL,
	resolveProjectId,
} from "./config";

/** Packaged standalone bundle, relative to the extension root (extension/dist/).
 *  Styles ship inside it and mount into the overlay's Shadow DOM — nothing is
 *  ever inserted into the host page's stylesheet cascade. */
const GLOBAL_JS = "bugtoprompt.global.js";

const tabStateKey = (tabId: number): string => `tab:${tabId}`;

export async function isTabActive(
	chromeApi: ChromeLike,
	tabId: number,
): Promise<boolean> {
	const session = chromeApi.storage.session;
	if (!session) return false;
	const key = tabStateKey(tabId);
	const raw = await session.get(key);
	const entry = raw?.[key];
	return (
		typeof entry === "object" &&
		entry !== null &&
		"active" in entry &&
		entry.active === true
	);
}

async function setTabActive(
	chromeApi: ChromeLike,
	tabId: number,
	active: boolean,
): Promise<void> {
	const session = chromeApi.storage.session;
	if (!session) return;
	const key = tabStateKey(tabId);
	if (active) {
		await session.set({ [key]: { active: true } });
	} else {
		await session.remove(key);
	}
}

/** Is the packaged overlay module already present in the page's MAIN world? */
export async function overlayPresent(
	chromeApi: ChromeLike,
	tabId: number,
): Promise<boolean> {
	const scripting = chromeApi.scripting;
	if (!scripting) return false;
	const results = await scripting.executeScript({
		target: { tabId },
		world: "MAIN",
		// A page may define an unrelated window.BugToPrompt; only treat the
		// bundle as present when it exposes the overlay's mount/unmount API.
		func: () =>
			typeof window.BugToPrompt?.mount === "function" &&
			typeof window.BugToPrompt?.unmount === "function",
	});
	return results?.[0]?.result === true;
}

/**
 * Seed the MAIN-world window.__BUGTOPROMPT__ config (manual:true so the bundle
 * does not auto-mount). Run on every activation so option and repo-binding
 * changes take effect even when the singleton from a prior activation persists.
 *
 * P0 (issue #82): the raw PRO Bearer token never crosses into the MAIN world —
 * any page script can read window.__BUGTOPROMPT__ and replay it. Only
 * `proEnabled` (a boolean) travels through the args object; `proToken` is
 * scrubbed to "" before serialization. The overlay gets `pro: { baseUrl,
 * bridged: true }` and relays authenticated calls through the ISOLATED-world
 * relay (see injectProRelay) to the service worker, which holds the token.
 */
async function seedConfig(
	chromeApi: ChromeLike,
	tabId: number,
	config: SyncConfig,
	projectId?: string,
): Promise<void> {
	const scripting = chromeApi.scripting;
	if (!scripting) return;
	await scripting.executeScript({
		target: { tabId },
		world: "MAIN",
		func: (
			cfg: SyncConfig & {
				projectId?: string;
				proBaseUrl: string;
				proEnabled: boolean;
			},
		) => {
			window.__BUGTOPROMPT__ = {
				baseUrl: cfg.baseUrl,
				modes: cfg.modes,
				defaultMode: cfg.defaultMode,
				screenshotMode: cfg.screenshotMode,
				autoVoice: cfg.autoVoice,
				// Per-domain repo mapping: undefined on localhost (zero-config), the
				// matched owner/repo on a bound non-localhost site.
				projectId: cfg.projectId,
				// Activation should give instant visible feedback: open the panel,
				// not just the floating launcher.
				defaultOpen: true,
				manual: true,
				// PRO: bridged mode only. The token itself never appears here — the
				// overlay relays authenticated calls through the extension instead
				// (see injectProRelay / executeProOp).
				pro: cfg.proEnabled
					? { baseUrl: cfg.proBaseUrl, bridged: true }
					: undefined,
			};
		},
		// func is serialized into the page and can't close over module
		// constants, so PRO_BASE_URL travels through the args object. proToken
		// is scrubbed to "" here — see the doc comment above.
		args: [
			{
				...config,
				proToken: "",
				proEnabled: Boolean(config.proToken),
				projectId,
				proBaseUrl: PRO_BASE_URL,
			},
		],
	});
}

/**
 * First-activation injection: seed window.__BUGTOPROMPT__, then the packaged
 * global JS which defines window.BugToPrompt without mounting.
 */
async function injectBundle(
	chromeApi: ChromeLike,
	tabId: number,
	config: SyncConfig,
	projectId?: string,
): Promise<void> {
	const scripting = chromeApi.scripting;
	if (!scripting) return;
	await seedConfig(chromeApi, tabId, config, projectId);
	await scripting.executeScript({
		target: { tabId },
		world: "MAIN",
		files: [GLOBAL_JS],
	});
}

async function callOverlay(
	chromeApi: ChromeLike,
	tabId: number,
	method: "mount" | "unmount",
): Promise<void> {
	const scripting = chromeApi.scripting;
	if (!scripting) return;
	await scripting.executeScript({
		target: { tabId },
		world: "MAIN",
		func: (m: "mount" | "unmount") => {
			window.BugToPrompt?.[m]();
		},
		args: [method],
	});
}

/**
 * Inject the ISOLATED-world relay content script (P1, issue #82, wire
 * contract v2.1). Generates a fresh `secret = crypto.randomUUID()` per
 * injection and passes it as the relay's one `executeScript` arg. The relay
 * is a self-contained serialized function (no closures over this module —
 * it runs in the page's ISOLATED world) that derives an AES-GCM key from
 * SHA-256(secret), listens for `window.postMessage` requests from the
 * MAIN-world overlay, and forwards only requests it can decrypt under that
 * key to the service worker via `chrome.runtime.sendMessage` (ISOLATED-world
 * content scripts get a `chrome` global with extension messaging access —
 * page scripts never do), replying with an encrypted
 * `{type:"btp:pro-response", id, enc}`. Every encrypt/decrypt binds an
 * `additionalData` AAD string to the *wire id and direction*
 * (`"btp:req:" + id` for requests, `"btp:res:" + id` for responses), so an
 * envelope captured off one wire id and replayed under another fails GCM
 * authentication and is dropped — no cross-id mix-and-match. The relay also
 * keeps a per-document replay guard split into two structures (round 3):
 * a bounded `inflightIds` set of tentative claims taken synchronously
 * before each async decrypt (released on decrypt failure, so garbage never
 * poisons a genuine id), and a `processedIds` set (FIFO-capped at 10,000)
 * that ids enter ONLY after a successful decrypt — eviction is therefore
 * driven exclusively by authenticated traffic, so a flood of secret-less
 * garbage can never push an already-forwarded id out of the window and
 * make its captured ciphertext replayable. A
 * `__btpProRelay` flag on `globalThis` makes re-injection into the same
 * document a no-op (the relay func returns `false`, and no new secret is
 * seeded); only on a *fresh* init (`true`) does this function also run a
 * second MAIN-world injection that hands the same secret to
 * `window.__btpProBridgeSecret.set` (registered by src/client/pro-bridge.ts
 * at module load) — page scripts cannot observe an executeScript
 * evaluation, so a passive listener never sees the secret. Plaintext
 * requests are dropped whenever `crypto.subtle` exists; only on a degraded
 * insecure-http origin (no `subtle`, so no envelope is possible anywhere)
 * does the relay fall back to legacy v1 plaintext forwarding — that
 * degraded path has neither AAD binding nor replay tracking (no crypto to
 * distinguish an attacker's forged message from the client's; documented
 * residual, unchanged from v1). The real Bearer token lives only in the
 * service worker; this relay never sees or stores it. Documented residual:
 * an active attacker who hijacks `window.__btpProBridgeSecret.set` before
 * pro-bridge.ts registers it (i.e. before the bundle's own module-load
 * runs) can still capture the secret — equivalent to any other MAIN-world
 * active-attack scenario, not a passive one.
 */
export async function injectProRelay(
	chromeApi: ChromeLike,
	tabId: number,
): Promise<void> {
	const scripting = chromeApi.scripting;
	if (!scripting) return;
	const secret = crypto.randomUUID();
	const results = await scripting.executeScript({
		target: { tabId },
		world: "ISOLATED",
		func: (secret: string): boolean => {
			// A well-known one-off global flag for content-script idempotency —
			// not in Window's ambient type, so this is a genuine unchecked cast.
			const flagged = globalThis as unknown as { __btpProRelay?: boolean };
			if (flagged.__btpProRelay) return false;
			flagged.__btpProRelay = true;

			// func is serialized into the page and can't close over module
			// scope, so `chrome` (a content-script global, not in the ambient
			// DOM lib here) is reached off globalThis instead of an import, and
			// every crypto/base64 helper below is inlined rather than imported.
			const globalWithChrome = globalThis as unknown as {
				chrome: {
					runtime: { sendMessage(msg: unknown): Promise<unknown> };
				};
			};
			const subtle: SubtleCrypto | undefined = globalThis.crypto?.subtle;
			// The encrypted paths below only run when an envelope exists, which
			// requires subtle on both worlds — this guard narrows the type and
			// turns an impossible state into a loud error instead of `!`.
			const requireSubtle = (): SubtleCrypto => {
				if (!subtle) throw new Error("crypto.subtle unavailable");
				return subtle;
			};

			const bytesToBase64 = (bytes: Uint8Array): string => {
				let binary = "";
				for (let i = 0; i < bytes.length; i++) {
					binary += String.fromCharCode(bytes[i]);
				}
				return btoa(binary);
			};
			const base64ToBytes = (b64: string): Uint8Array<ArrayBuffer> => {
				const binary = atob(b64);
				const bytes = new Uint8Array(binary.length);
				for (let i = 0; i < binary.length; i++) {
					bytes[i] = binary.charCodeAt(i);
				}
				return bytes;
			};

			let keyPromise: Promise<CryptoKey> | undefined;
			const getKey = (): Promise<CryptoKey> => {
				if (!keyPromise) {
					const sub = requireSubtle();
					keyPromise = sub
						.digest("SHA-256", new TextEncoder().encode(secret))
						.then((rawKey) =>
							sub.importKey("raw", rawKey, "AES-GCM", false, [
								"encrypt",
								"decrypt",
							]),
						);
				}
				return keyPromise;
			};
			const encryptEnvelope = async (
				obj: unknown,
				aad: string,
			): Promise<{ iv: string; data: string }> => {
				const key = await getKey();
				const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
				const plain = new TextEncoder().encode(JSON.stringify(obj));
				const cipher = await requireSubtle().encrypt(
					{
						name: "AES-GCM",
						iv,
						additionalData: new TextEncoder().encode(aad),
					},
					key,
					plain,
				);
				return {
					iv: bytesToBase64(iv),
					data: bytesToBase64(new Uint8Array(cipher)),
				};
			};
			const decryptEnvelope = async (
				enc: { iv: string; data: string },
				aad: string,
			): Promise<unknown> => {
				const key = await getKey();
				const plain = await requireSubtle().decrypt(
					{
						name: "AES-GCM",
						iv: base64ToBytes(enc.iv),
						additionalData: new TextEncoder().encode(aad),
					},
					key,
					base64ToBytes(enc.data),
				);
				return JSON.parse(new TextDecoder().decode(plain));
			};

			// Per-document replay guard (wire contract v2.1 §2, hardened in
			// round 3): TWO structures, so unauthenticated traffic can never
			// evict a genuine processed id out of the replay window.
			//  - `inflightIds`: tentative claims, taken synchronously the
			//    instant a wire id is first seen — before its async decrypt
			//    starts — so a duplicate arriving in the same message burst
			//    is dropped too. Released on decrypt/parse failure (garbage
			//    must not poison a genuine id). Capped: under a flood of
			//    secret-less envelopes, NEW requests get no claim. The FIRST
			//    such request per saturation episode is fast-failed with an
			//    encrypted error (issue #88 residual 1 — a genuine same-tick
			//    request rejects at once instead of hanging on the client's
			//    120s timeout); the rest are dropped silently so a flood can't
			//    force per-message crypto (fail closed — a transient DoS at
			//    worst) rather than the set growing without bound.
			//  - `processedIds`: ids whose decrypt SUCCEEDED. Enqueued into
			//    the evictable FIFO only at that point, so only
			//    authenticated envelopes — which require the secret — can
			//    advance the eviction window. A captured genuine ciphertext
			//    replayed after any amount of garbage flooding still hits
			//    this set and is dropped (the round-3 P0: eviction driven by
			//    claim-time enqueueing let cheap garbage push a forwarded id
			//    out of the window and replay it).
			// Not used by the degraded plaintext path below: there's no
			// crypto there to tell an attacker's forged message apart from
			// the client's, so replay tracking would be theater — documented
			// residual, unchanged from v1.
			const inflightIds = new Set<string>();
			const MAX_INFLIGHT_IDS = 1_000;
			const processedIds = new Set<string>();
			const processedQueue: string[] = [];
			const MAX_PROCESSED_IDS = 10_000;
			// One courtesy fast-fail per saturation episode (issue #88): armed
			// only when a claim enters an EMPTY inflight set — i.e. the start of
			// a fresh episode after the pipe fully drained — and spent when we
			// emit an error while saturated. So a genuine request caught the
			// instant inflight fills rejects fast instead of hanging on the
			// client's 120s timeout, WITHOUT letting a secret-less flood turn
			// every message into an AES-GCM encrypt + postMessage: re-arming on
			// every admit would let sustained near-cap traffic retrigger an
			// error each time a slot briefly opens (cubic PR #108). After the
			// first, saturated requests are dropped silently until the flood
			// fully drains (fail closed) — re-introducing the per-garbage work
			// #83 deliberately avoided is exactly what this bound prevents.
			let saturationErrorArmed = true;
			const markProcessed = (id: string): void => {
				inflightIds.delete(id);
				processedIds.add(id);
				processedQueue.push(id);
				if (processedQueue.length > MAX_PROCESSED_IDS) {
					const evicted = processedQueue.shift();
					if (evicted !== undefined) processedIds.delete(evicted);
				}
			};
			// Decrypt + forward one encrypted request. Split into two try
			// blocks so the tentative in-flight claim is only released on a
			// decrypt/parse failure (garbage, or an envelope lifted from
			// another wire id — AAD mismatch); the moment decrypt succeeds
			// the id is marked processed FOREVER (document lifetime, modulo
			// the authenticated-only FIFO cap), so a replay can never
			// trigger a second forward.
			const handleEncryptedRequest = async (
				id: string,
				enc: { iv: string; data: string },
			): Promise<void> => {
				let request: { op: string; payload?: unknown };
				try {
					const parsed = await decryptEnvelope(enc, `btp:req:${id}`);
					if (
						typeof parsed !== "object" ||
						parsed === null ||
						!("op" in parsed) ||
						typeof (parsed as { op: unknown }).op !== "string"
					) {
						throw new Error("bad request shape");
					}
					request = parsed as { op: string; payload?: unknown };
				} catch {
					// Forged/garbage envelope, or a genuine envelope re-posted
					// under a different wire id (AAD mismatch) — decrypt/parse
					// failed before anything was forwarded. Release the
					// tentative claim: a genuine retry under the same id must
					// not be permanently poisoned by an attacker's garbage.
					inflightIds.delete(id);
					return;
				}
				// Decrypt succeeded under this document's secret: promote the
				// id to the processed set BEFORE forwarding, so nothing —
				// including a concurrent replay racing the forward — can run
				// the op twice.
				markProcessed(id);
				try {
					const resp = await globalWithChrome.chrome.runtime
						.sendMessage({
							type: "btp:pro-request",
							op: request.op,
							payload: request.payload,
						})
						.catch((err: unknown) => ({ ok: false, error: String(err) }));
					const respObj =
						resp && typeof resp === "object"
							? resp
							: { ok: false, error: "empty response" };
					const responseEnc = await encryptEnvelope(respObj, `btp:res:${id}`);
					window.postMessage(
						{ type: "btp:pro-response", id, enc: responseEnc },
						"/",
					);
				} catch {
					// sendMessage already ran (the op was forwarded exactly
					// once) — only response re-encryption failed. Nothing safe
					// to send back, so drop silently; the claim stays so a
					// replay can't trigger a second forward.
				}
			};

			window.addEventListener("message", (ev: MessageEvent) => {
				if (ev.source !== window) return;
				const data: unknown = ev.data;
				if (
					typeof data !== "object" ||
					data === null ||
					!("type" in data) ||
					data.type !== "btp:pro-request" ||
					!("id" in data) ||
					typeof data.id !== "string"
				) {
					return;
				}
				const id = data.id;
				const enc = "enc" in data ? data.enc : undefined;

				if (enc && typeof enc === "object") {
					// Encrypted path: only requests that decrypt under this
					// document's secret and this exact wire id are ever
					// forwarded — a page script without the secret can't forge
					// one, and a captured envelope replayed or rebound to
					// another id fails AAD auth (wire contract v2.1).
					if (!subtle) return; // no subtle: a real envelope can't exist here
					// Replay or same-burst duplicate: processed ids are
					// permanent (authenticated-only FIFO); in-flight ids are
					// tentative. Either way, drop without a second decrypt.
					if (processedIds.has(id) || inflightIds.has(id)) return;
					// Flood guard: bounded tentative claims. Rather than drop
					// the first saturated request silently — it would surface
					// to a genuine same-tick caller only via the client's 120s
					// timeout (issue #88 residual 1) — fast-fail it once with an
					// encrypted error so a genuine client rejects immediately.
					// The envelope is sealed under this document's secret, so
					// only a genuine client can read it (a secret-less flood
					// sees opaque noise, no leak). The one-shot arming caps this
					// at a single encrypt+post per saturation episode, so a
					// flood can't turn every message into crypto/postMessage
					// spam. Honest scope: this reliably helps benign/first-arrival
					// saturation. Under an adversarial flood the attacker's own
					// overflow can spend the one courtesy error before a genuine
					// same-tick victim arrives, so that victim still falls back to
					// the 120s timeout — inherent, since genuine and garbage are
					// indistinguishable pre-decrypt and decrypt-to-target would
					// reintroduce per-garbage crypto. No forward happens either
					// way: the id never gets a claim, so a later retry is still
					// served once the pipe drains.
					if (inflightIds.size >= MAX_INFLIGHT_IDS) {
						if (saturationErrorArmed) {
							saturationErrorArmed = false;
							void (async () => {
								try {
									const responseEnc = await encryptEnvelope(
										{
											ok: false,
											error: "bridge busy: too many in-flight requests",
										},
										`btp:res:${id}`,
									);
									window.postMessage(
										{ type: "btp:pro-response", id, enc: responseEnc },
										"/",
									);
								} catch {
									// Re-encrypt failed — nothing safe to send; the
									// client falls back to its timeout, as before.
								}
							})();
						}
						return;
					}
					// Re-arm the courtesy fast-fail only when this claim enters an
					// EMPTY pipe — i.e. a fresh saturation episode after inflight
					// has fully drained. Re-arming on every admit (incl. an
					// unverified garbage claim) would let sustained near-cap
					// traffic retrigger an encrypted error each time a slot
					// briefly opens, defeating the one-per-flood crypto/postMessage
					// bound (cubic PR #108 finding).
					if (inflightIds.size === 0) saturationErrorArmed = true;
					inflightIds.add(id); // tentative claim before the async decrypt
					void handleEncryptedRequest(id, enc as { iv: string; data: string });
					return;
				}

				if (!("op" in data) || typeof data.op !== "string") return;
				if (subtle) return; // secure context: plaintext requests are dropped
				// Degraded insecure-http origin (no crypto.subtle anywhere): fall
				// back to legacy v1 plaintext forwarding.
				const request = data as { op: string; payload?: unknown };
				globalWithChrome.chrome.runtime
					.sendMessage({
						type: "btp:pro-request",
						op: request.op,
						payload: request.payload,
					})
					.then((resp: unknown) => {
						if (!resp || typeof resp !== "object") {
							throw new Error("empty response");
						}
						window.postMessage({ type: "btp:pro-response", id, ...resp }, "/");
					})
					.catch((err: unknown) => {
						window.postMessage(
							{ type: "btp:pro-response", id, ok: false, error: String(err) },
							"/",
						);
					});
			});

			return true;
		},
		args: [secret],
	});
	if (results?.[0]?.result !== true) return; // relay already resident: no fresh secret to seed
	await scripting.executeScript({
		target: { tabId },
		world: "MAIN",
		func: (s: string) => {
			// window.__btpProBridgeSecret is defined by src/client/pro-bridge.ts
			// at module load, not in the ambient Window type here — a genuine
			// unchecked cast, matching the relay's own flag cast above.
			const bridge = window as unknown as {
				__btpProBridgeSecret?: { set?: (secret: string) => void };
			};
			bridge.__btpProBridgeSecret?.set?.(s);
		},
		args: [secret],
	});
}

/**
 * Guarantee an overlay is mounted in the tab. Injects the bundle only when the
 * MAIN-world singleton is absent (fresh document); when reusing an existing
 * singleton it re-seeds the config so the remount picks up current options.
 * When PRO is active, also (re-)injects the ISOLATED-world relay so the
 * overlay's bridged client can reach the service worker.
 */
export async function ensureOverlay(
	chromeApi: ChromeLike,
	tabId: number,
	config: SyncConfig,
	projectId?: string,
): Promise<void> {
	if (await overlayPresent(chromeApi, tabId)) {
		await seedConfig(chromeApi, tabId, config, projectId);
	} else {
		await injectBundle(chromeApi, tabId, config, projectId);
	}
	if (config.proToken) await injectProRelay(chromeApi, tabId);
	await callOverlay(chromeApi, tabId, "mount");
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
	return Array.isArray(v) && v.every((x) => typeof x === "string");
}

interface ProOpSpec {
	method: "GET" | "POST";
	path(payload: Record<string, unknown>): string;
	validate(payload: unknown): payload is Record<string, unknown>;
}

/** Named PRO ops (frozen contract, shared with src/client/pro-bridge.ts). Each
 *  maps 1:1 to a BugToPromptClient method; the URL is built ONLY from
 *  PRO_BASE_URL + a fixed path here — never from the untrusted payload. */
const PRO_OPS: Record<string, ProOpSpec> = {
	mintStreamingToken: {
		method: "POST",
		path: () => "/streaming-token",
		validate: (p): p is Record<string, unknown> =>
			isPlainObject(p) &&
			(p.targetId === undefined || typeof p.targetId === "string"),
	},
	saveArtifact: {
		method: "POST",
		path: () => "/artifact",
		validate: (p): p is Record<string, unknown> =>
			isPlainObject(p) &&
			isPlainObject(p.artifact) &&
			typeof p.audioBase64 === "string" &&
			isStringArray(p.screenshotsBase64),
	},
	transcribeBatch: {
		method: "POST",
		path: () => "/transcribe",
		validate: (p): p is Record<string, unknown> =>
			isPlainObject(p) &&
			typeof p.sessionId === "string" &&
			(p.targetId === undefined || typeof p.targetId === "string"),
	},
	createIssue: {
		method: "POST",
		path: () => "/issue",
		validate: (p): p is Record<string, unknown> =>
			isPlainObject(p) &&
			typeof p.sessionId === "string" &&
			typeof p.prompt === "string" &&
			(p.artifactRef === undefined || typeof p.artifactRef === "string") &&
			(p.transcriptText === undefined ||
				typeof p.transcriptText === "string") &&
			(p.targetId === undefined || typeof p.targetId === "string"),
	},
	listTargets: {
		method: "GET",
		path: (p) =>
			`/targets?projectId=${encodeURIComponent(String(p.projectId))}`,
		validate: (p): p is Record<string, unknown> =>
			isPlainObject(p) && typeof p.projectId === "string",
	},
};

/**
 * Execute one PRO op on behalf of the ISOLATED-world relay (P0/P1, issue
 * #82). This is the ONLY place the real Bearer token is read and attached —
 * it never leaves the service worker. Two independent layers now gate a call
 * ever reaching this function: (1) `init`'s `btp:pro-request` handler
 * requires the sender's tab to be actively capturing (`isTabActive`) — a
 * relay left resident on a tab after `deactivateTab` can no longer drive ops
 * just by still being there; (2) in secure contexts the relay itself only
 * forwards requests it decrypted under an AES-GCM envelope keyed by a
 * per-injection secret that never crosses `window.postMessage` in the open
 * (wire contract v2, see injectProRelay), so a generic page script observing
 * postMessage traffic cannot forge one. The closed op table + payload shape
 * validation + a URL built only from the fixed PRO_BASE_URL constant (never
 * the payload) remain as defense in depth regardless. Two narrower residuals
 * remain: (a) a degraded insecure-http origin, where no `crypto.subtle`
 * exists anywhere and the relay falls back to legacy plaintext forwarding
 * while the tab is active — any page script there can still drive ops,
 * exactly as before; (b) an active attacker who hijacks
 * `window.__btpProBridgeSecret.set` before pro-bridge.ts registers it,
 * capturing the secret at seed time. Neither residual lets a page observe or
 * exfiltrate the token itself.
 */
export async function executeProOp(
	chromeApi: ChromeLike,
	op: string,
	payload: unknown,
	fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
	const config = await loadConfig(chromeApi);
	if (!config.proToken) return { ok: false, error: "PRO is not active" };
	const spec = PRO_OPS[op];
	if (!spec) return { ok: false, error: "unknown op" };
	if (!spec.validate(payload)) return { ok: false, error: "invalid payload" };
	const url = `${PRO_BASE_URL}${spec.path(payload)}`;
	try {
		const res = await fetchImpl(url, {
			method: spec.method,
			headers: {
				Authorization: `Bearer ${config.proToken}`,
				...(spec.method === "POST"
					? { "Content-Type": "application/json" }
					: {}),
			},
			...(spec.method === "POST" ? { body: JSON.stringify(payload) } : {}),
		});
		if (!res.ok) {
			const text = await res.text();
			return { ok: false, error: `${res.status} ${res.statusText}: ${text}` };
		}
		return { ok: true, result: await res.json() };
	} catch (err) {
		return { ok: false, error: String(err) };
	}
}

export interface ToggleResult {
	active: boolean;
	error?: string;
}

/**
 * Decide whether a page may be attached to. Loopback HTTP is always allowed
 * (zero-config, as today). Any other http(s) host needs a granted origin
 * permission (the popup requests it). chrome://, file://, and the Web Store
 * are never attachable.
 */
async function pageActivatable(
	chromeApi: ChromeLike,
	url: string | undefined,
): Promise<ToggleResult | undefined> {
	const kind = classifyPage(url);
	if (kind === "loopback") return undefined;
	if (kind === "http") {
		const pattern = originPattern(url);
		const granted = pattern
			? await (chromeApi.permissions?.contains({ origins: [pattern] }) ??
					Promise.resolve(false))
			: false;
		if (granted) return undefined;
		return {
			active: false,
			error: "Enable BugToPrompt on this site from the popup first.",
		};
	}
	return {
		active: false,
		error:
			"BugToPrompt can't run on this page (chrome://, file://, or the Web Store).",
	};
}

/** Activate capture on a tab; rejects unattachable pages before any injection. */
export async function activateTab(
	chromeApi: ChromeLike,
	tab: { id?: number; url?: string },
	config: SyncConfig,
	fetchImpl: typeof fetch = fetch,
): Promise<ToggleResult> {
	if (typeof tab.id !== "number") {
		return { active: false, error: "No active tab." };
	}
	const blocked = await pageActivatable(chromeApi, tab.url);
	if (blocked) return blocked;
	await setTabActive(chromeApi, tab.id, true);
	try {
		// Auto-discover the sidecar for this tab (configured URL → tab port + 3 →
		// portless default) so the injected overlay talks to the right port with
		// zero manual configuration.
		const { baseUrl } = await discoverBaseUrl(
			candidateBaseUrls(config.baseUrl, tab.url),
			fetchImpl,
		);
		// Per-domain mapping: undefined on localhost, matched repo on a bound site.
		const projectId = resolveProjectId(
			config.siteBindings,
			hostnameOf(tab.url),
		);
		await ensureOverlay(chromeApi, tab.id, { ...config, baseUrl }, projectId);
	} catch (err) {
		// Injection failed (e.g. the page rejected executeScript): roll back so a
		// later toggle retries activation instead of trying to stop a dead overlay.
		await setTabActive(chromeApi, tab.id, false);
		throw err;
	}
	return { active: true };
}

export async function deactivateTab(
	chromeApi: ChromeLike,
	tabId: number,
): Promise<ToggleResult> {
	try {
		// May reject on a page that navigated to a protected URL (chrome://,
		// etc.) where there is no accessible document left to unmount.
		await callOverlay(chromeApi, tabId, "unmount");
	} finally {
		// Always clear state so the popup and stored flag stay recoverable.
		await setTabActive(chromeApi, tabId, false);
	}
	return { active: false };
}

export async function toggleTab(
	chromeApi: ChromeLike,
	tab: { id?: number; url?: string },
	config: SyncConfig,
	fetchImpl: typeof fetch = fetch,
): Promise<ToggleResult> {
	if (typeof tab.id === "number" && (await isTabActive(chromeApi, tab.id))) {
		return deactivateTab(chromeApi, tab.id);
	}
	return activateTab(chromeApi, tab, config, fetchImpl);
}

/** The hostname of a tab URL, or undefined when it can't be parsed. */
function hostnameOf(url: string | undefined): string | undefined {
	if (!url) return undefined;
	try {
		return new URL(url).hostname;
	} catch {
		return undefined;
	}
}

/**
 * A fresh document (localhost content script report, or a non-localhost
 * onUpdated=complete event) has no MAIN-world singleton, so an active tab is
 * reinjected and remounted automatically.
 */
export async function handleDocumentReady(
	chromeApi: ChromeLike,
	tabId: number,
	tabUrl?: string,
	fetchImpl: typeof fetch = fetch,
): Promise<void> {
	if (!(await isTabActive(chromeApi, tabId))) return;
	// When we know the destination URL, an active tab may have navigated to a
	// page we can no longer attach to (chrome://, the Web Store, an ungranted
	// origin). Clear state and skip injection so it is not left reported active
	// with no overlay. A missing URL is left untouched (destination unknown).
	if (tabUrl !== undefined && (await pageActivatable(chromeApi, tabUrl))) {
		await setTabActive(chromeApi, tabId, false);
		return;
	}
	const config = await loadConfig(chromeApi);
	// Same auto-discovery as activation so the remounted overlay keeps talking
	// to the right sidecar port after a full navigation.
	const { baseUrl } = await discoverBaseUrl(
		candidateBaseUrls(config.baseUrl, tabUrl),
		fetchImpl,
	);
	const projectId = resolveProjectId(config.siteBindings, hostnameOf(tabUrl));
	await ensureOverlay(chromeApi, tabId, { ...config, baseUrl }, projectId);
}

async function activeTab(
	chromeApi: ChromeLike,
): Promise<{ id?: number; url?: string } | undefined> {
	const tabs = chromeApi.tabs;
	if (!tabs) return undefined;
	const found = await tabs.query({ active: true, currentWindow: true });
	return found?.[0];
}

/** Wire the service worker to the real `chrome` global. No-op under test/jsdom. */
export function init(chromeApi: ChromeLike): void {
	chromeApi.runtime?.onMessage?.addListener((msg, sender, sendResponse) => {
		if (typeof msg !== "object" || msg === null || !("type" in msg)) {
			return undefined;
		}
		const type = msg.type;
		if (type === "btp:document-ready") {
			const tabId = sender.tab?.id;
			if (typeof tabId === "number") {
				void handleDocumentReady(chromeApi, tabId, sender.tab?.url);
			}
			return undefined;
		}
		if (type === "btp:pro-request") {
			// Only accept requests carrying a real sender tab id, and only act on
			// them while that tab is actively capturing — otherwise a relay left
			// resident after deactivateTab (capture off) could still drive
			// authenticated PRO ops (P1, issue #82 finding 1).
			const tabId = sender.tab?.id;
			if (typeof tabId !== "number") {
				sendResponse({ ok: false, error: "unauthorized" });
				return undefined;
			}
			void (async () => {
				if (!(await isTabActive(chromeApi, tabId))) {
					sendResponse({ ok: false, error: "unauthorized" });
					return;
				}
				const req = msg as { op?: unknown; payload?: unknown };
				const op = typeof req.op === "string" ? req.op : "";
				sendResponse(await executeProOp(chromeApi, op, req.payload));
			})();
			return true; // async sendResponse
		}
		if (type === "btp:toggle" || type === "btp:state") {
			void (async () => {
				const tab = await activeTab(chromeApi);
				const config = await loadConfig(chromeApi);
				if (!tab || typeof tab.id !== "number") {
					sendResponse({ active: false, supported: false });
					return;
				}
				const supported = classifyPage(tab.url) === "loopback";
				if (type === "btp:state") {
					sendResponse({
						active: await isTabActive(chromeApi, tab.id),
						supported,
					});
					return;
				}
				try {
					sendResponse(await toggleTab(chromeApi, tab, config));
				} catch {
					// Injection failed: still answer so the popup clears its spinner
					// and shows an error instead of hanging on a dead channel.
					sendResponse({
						active: await isTabActive(chromeApi, tab.id),
						error: "BugToPrompt could not update this tab.",
					});
				}
			})();
			return true; // async sendResponse
		}
		return undefined;
	});
	// Non-localhost pages have no content script to report readiness, so the
	// service worker watches for completed navigations and reinjects into any
	// tab that is still session-active. handleDocumentReady no-ops otherwise.
	chromeApi.tabs?.onUpdated?.addListener((tabId, changeInfo, tab) => {
		if (changeInfo.status !== "complete") return;
		// Loopback pages have the content script, which already reports readiness
		// via btp:document-ready. Skip them here so a localhost navigation does
		// not run two readiness handlers and mount duplicate overlays.
		if (classifyPage(tab.url) === "loopback") return;
		void handleDocumentReady(chromeApi, tabId, tab.url);
	});
}

// Bootstrap against the real service-worker global. Guarded so importing this
// module under Vitest (no `chrome`) is a no-op.
declare const chrome: ChromeLike & {
	commands?: {
		onCommand: {
			addListener(cb: (command: string) => void): void;
		};
	};
};
const maybeChrome = typeof chrome !== "undefined" ? chrome : undefined;
if (maybeChrome?.runtime) {
	init(maybeChrome);
	maybeChrome.commands?.onCommand.addListener((command) => {
		if (command !== "toggle-capture") return;
		void (async () => {
			const tab = await activeTab(maybeChrome);
			const config = await loadConfig(maybeChrome);
			if (tab) await toggleTab(maybeChrome, tab, config);
		})();
	});
}
