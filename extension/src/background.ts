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
		func: () => typeof window.BugToPrompt !== "undefined",
	});
	return results?.[0]?.result === true;
}

/**
 * First-activation injection: seed window.__BUGTOPROMPT__ (manual:true so the
 * bundle does not auto-mount), inject the packaged CSS, then the packaged
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
	await scripting.executeScript({
		target: { tabId },
		world: "MAIN",
		func: (cfg: SyncConfig & { projectId?: string }) => {
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
			};
		},
		args: [{ ...config, projectId }],
	});
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
 * Guarantee an overlay is mounted in the tab. Injects the bundle only when the
 * MAIN-world singleton is absent (fresh document), otherwise reuses it.
 */
export async function ensureOverlay(
	chromeApi: ChromeLike,
	tabId: number,
	config: SyncConfig,
	projectId?: string,
): Promise<void> {
	if (!(await overlayPresent(chromeApi, tabId))) {
		await injectBundle(chromeApi, tabId, config, projectId);
	}
	await callOverlay(chromeApi, tabId, "mount");
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
	// Auto-discover the sidecar for this tab (configured URL → tab port + 3 →
	// portless default) so the injected overlay talks to the right port with
	// zero manual configuration.
	const { baseUrl } = await discoverBaseUrl(
		candidateBaseUrls(config.baseUrl, tab.url),
		fetchImpl,
	);
	// Per-domain mapping: undefined on localhost, the matched repo on a bound site.
	const projectId = resolveProjectId(config.siteBindings, hostnameOf(tab.url));
	await ensureOverlay(chromeApi, tab.id, { ...config, baseUrl }, projectId);
	return { active: true };
}

export async function deactivateTab(
	chromeApi: ChromeLike,
	tabId: number,
): Promise<ToggleResult> {
	await callOverlay(chromeApi, tabId, "unmount");
	await setTabActive(chromeApi, tabId, false);
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
				sendResponse(await toggleTab(chromeApi, tab, config));
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
