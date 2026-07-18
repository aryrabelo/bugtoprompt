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
 * Inject the ISOLATED-world relay content script (P0, issue #82). Runs once
 * per document (guarded by a `__btpProRelay` flag on globalThis so a re-seed
 * on the same document is a no-op): listens for `window.postMessage({type:
 * "btp:pro-request", id, op, payload})` from the MAIN-world overlay, forwards
 * it to the service worker via `chrome.runtime.sendMessage` (ISOLATED-world
 * content scripts get a `chrome` global with extension messaging access —
 * page scripts never do), and posts the `{type:"btp:pro-response", id, ...}`
 * reply back. The real Bearer token lives only in the service worker; this
 * relay never sees or stores it.
 */
export async function injectProRelay(
	chromeApi: ChromeLike,
	tabId: number,
): Promise<void> {
	const scripting = chromeApi.scripting;
	if (!scripting) return;
	await scripting.executeScript({
		target: { tabId },
		world: "ISOLATED",
		func: () => {
			// A well-known one-off global flag for content-script idempotency —
			// not in Window's ambient type, so this is a genuine unchecked cast.
			const flagged = globalThis as unknown as { __btpProRelay?: boolean };
			if (flagged.__btpProRelay) return;
			flagged.__btpProRelay = true;
			window.addEventListener("message", (ev: MessageEvent) => {
				if (ev.source !== window) return;
				const data: unknown = ev.data;
				if (
					typeof data !== "object" ||
					data === null ||
					!("type" in data) ||
					data.type !== "btp:pro-request" ||
					!("id" in data) ||
					typeof data.id !== "string" ||
					!("op" in data) ||
					typeof data.op !== "string"
				) {
					return;
				}
				// The `in`/typeof checks above proved the shape at runtime; name the
				// cast once instead of re-asserting per property access below.
				const request = data as {
					id: string;
					op: string;
					payload?: unknown;
				};
				// func is serialized into the page and can't close over module
				// scope, so `chrome` (a content-script global, not in the ambient
				// DOM lib here) is reached off globalThis instead of an import.
				const globalWithChrome = globalThis as unknown as {
					chrome: {
						runtime: { sendMessage(msg: unknown): Promise<unknown> };
					};
				};
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
						window.postMessage(
							{ type: "btp:pro-response", id: request.id, ...resp },
							"/",
						);
					})
					.catch((err: unknown) => {
						window.postMessage(
							{
								type: "btp:pro-response",
								id: request.id,
								ok: false,
								error: String(err),
							},
							"/",
						);
					});
			});
		},
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
 * Execute one PRO op on behalf of the ISOLATED-world relay (P0, issue #82).
 * This is the ONLY place the real Bearer token is read and attached — it
 * never leaves the service worker. Confused-deputy posture: any page script
 * on an actively-capturing tab can trigger these named ops (through the
 * relay), so the defense is a closed op table + payload shape validation + a
 * URL built only from the fixed PRO_BASE_URL constant (never the payload).
 * The residual risk is that a hostile page can drive mintStreamingToken /
 * saveArtifact / transcribeBatch / createIssue / listTargets while capture is
 * on — it can never observe or exfiltrate the token itself.
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
			// Only accept requests carrying a real sender tab (a page context);
			// drop anything else without invoking executeProOp.
			if (!sender.tab) {
				sendResponse({ ok: false, error: "unauthorized" });
				return undefined;
			}
			const req = msg as { op?: unknown; payload?: unknown };
			const op = typeof req.op === "string" ? req.op : "";
			void executeProOp(chromeApi, op, req.payload).then(sendResponse);
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
