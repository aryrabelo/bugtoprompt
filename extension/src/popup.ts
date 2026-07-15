/**
 * Popup UI — a compact, Jam-like recorder launcher. Controls activation only;
 * the in-page overlay owns microphone/display gestures and the record/review
 * state machine. Dependency-free DOM; pure model helpers are exported for tests.
 */

import type { ChromeLike, PageKind, SyncConfig } from "./config";
import {
	candidateBaseUrls,
	classifyPage,
	discoverBaseUrl,
	loadConfig,
	originPattern,
	pageOrigin,
} from "./config";

/** What the popup's primary button does for the current tab. */
export type PopupMode = "toggle" | "enable" | "blocked";

/**
 * Decide the primary-button behaviour. An already-active tab, a loopback page,
 * or a granted non-localhost origin can be toggled directly. An ungranted
 * http(s) page offers "Enable on this site". chrome://, file://, and the Web
 * Store are blocked.
 */
export function popupMode(
	kind: PageKind,
	granted: boolean,
	active: boolean,
): PopupMode {
	if (active || kind === "loopback") return "toggle";
	if (kind === "http") return granted ? "toggle" : "enable";
	return "blocked";
}

/**
 * Message shown when the sidecar health probe fails. For a bound non-localhost
 * site the likely cause is the sidecar's origin allowlist, so surface the exact
 * env fix; otherwise fall back to the generic offline note.
 */
export function offlineHint(origin: string | undefined): string {
	if (!origin) {
		return "Sidecar offline. Start the BugToPrompt sidecar and retry.";
	}
	return `Sidecar unreachable for ${origin}. If it's running, restart it with BUGTOPROMPT_ALLOWED_ORIGINS=${origin} so it accepts this site (CORS).`;
}

export type GhState = "ready" | "missing" | "unauthenticated";
export type TranscriptionState = "ready" | "local" | "unconfigured";

export interface HealthPayload {
	ok: true;
	issues: boolean;
	repos: number;
	gh: GhState;
	transcription: TranscriptionState;
	originAllowed: boolean;
}

/** Fetch and validate the sidecar /health contract. Returns null when down. */
export async function fetchHealth(
	baseUrl: string,
	fetchImpl: typeof fetch,
	timeoutMs?: number,
	origin?: string,
): Promise<HealthPayload | null> {
	let raw: unknown;
	try {
		// Bound the probe so a hung /health never keeps the popup spinning; the
		// button is already wired independently of this result. Prefer
		// AbortSignal.timeout (Chrome 124+); fall back to an AbortController timer
		// on older Chrome so the probe stays bounded there too.
		let signal: AbortSignal | undefined;
		let timer: number | undefined;
		if (typeof timeoutMs === "number") {
			if (
				typeof AbortSignal !== "undefined" &&
				typeof AbortSignal.timeout === "function"
			) {
				signal = AbortSignal.timeout(timeoutMs);
			} else if (typeof AbortController !== "undefined") {
				const ctrl = new AbortController();
				timer = setTimeout(() => ctrl.abort(), timeoutMs);
				signal = ctrl.signal;
			}
		}
		try {
			const url = origin
				? `${baseUrl}/health?origin=${encodeURIComponent(origin)}`
				: `${baseUrl}/health`;
			const res = await (signal ? fetchImpl(url, { signal }) : fetchImpl(url));
			if (!res.ok) return null;
			raw = await res.json();
		} finally {
			clearTimeout(timer);
		}
	} catch {
		return null;
	}
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as Record<string, unknown>;
	if (r.ok !== true) return null;
	if (typeof r.issues !== "boolean") return null;
	if (typeof r.repos !== "number") return null;
	if (r.gh !== "ready" && r.gh !== "missing" && r.gh !== "unauthenticated") {
		return null;
	}
	if (
		r.transcription !== "ready" &&
		r.transcription !== "local" &&
		r.transcription !== "unconfigured"
	) {
		return null;
	}
	if (typeof r.originAllowed !== "boolean") return null;
	return {
		ok: true,
		issues: r.issues,
		repos: r.repos,
		gh: r.gh,
		transcription: r.transcription,
		originAllowed: r.originAllowed,
	};
}

export interface StatusPill {
	label: string;
	tone: "ok" | "warn" | "down";
}

export function healthPill(health: HealthPayload | null): StatusPill {
	if (!health) return { label: "Sidecar offline", tone: "down" };
	if (health.issues && health.gh !== "ready") {
		return { label: "Sidecar up · gh not ready", tone: "warn" };
	}
	return { label: "Sidecar ready", tone: "ok" };
}

export interface CapabilityRow {
	key: "capture" | "voice" | "issue";
	title: string;
	status: string;
	ready: boolean;
}

export function buildRows(
	config: SyncConfig,
	health: HealthPayload | null,
): CapabilityRow[] {
	const captureStatus =
		config.screenshotMode === "off"
			? "Disabled"
			: config.screenshotMode === "onClick"
				? "On every click"
				: config.screenshotMode === "perPage"
					? "Per page"
					: "On mark";
	const voiceReady =
		health?.transcription === "ready" || health?.transcription === "local";
	const voiceStatus = !health
		? "Sidecar offline"
		: voiceReady
			? config.autoVoice
				? "Ready · armed"
				: "Ready · manual"
			: "Not configured";
	const issueReady = health?.gh === "ready" && health.issues;
	const issueStatus = !health
		? "Sidecar offline"
		: !health.issues
			? "Issue filing disabled"
			: health.gh === "missing"
				? "gh CLI missing"
				: health.gh === "unauthenticated"
					? "gh not authenticated"
					: `${health.repos} repo(s)`;
	return [
		{
			key: "capture",
			title: "Capture clicks",
			status: captureStatus,
			ready: config.screenshotMode !== "off",
		},
		{
			key: "voice",
			title: "Voice transcription",
			status: voiceStatus,
			ready: voiceReady,
		},
		{
			key: "issue",
			title: "GitHub issue",
			status: issueStatus,
			ready: Boolean(issueReady),
		},
	];
}

// ---------------------------------------------------------------------------
// DOM wiring (skipped under jsdom/tests where there is no popup document)
// ---------------------------------------------------------------------------

interface StateResponse {
	active: boolean;
	supported: boolean;
}

function renderPill(el: HTMLElement, pill: StatusPill): void {
	el.textContent = pill.label;
	el.dataset.tone = pill.tone;
}

function renderRows(list: HTMLElement, rows: CapabilityRow[]): void {
	list.replaceChildren();
	for (const row of rows) {
		const item = document.createElement("div");
		item.className = "row";
		item.dataset.ready = String(row.ready);
		const title = document.createElement("span");
		title.className = "row-title";
		title.textContent = row.title;
		const status = document.createElement("span");
		status.className = "row-status";
		status.textContent = row.status;
		item.append(title, status);
		list.appendChild(item);
	}
}

async function initPopup(chromeApi: ChromeLike): Promise<void> {
	const pillEl = document.getElementById("status-pill");
	const targetEl = document.getElementById("target");
	const rowsEl = document.getElementById("rows");
	const startBtn = document.getElementById("start");
	const errEl = document.getElementById("error");
	if (
		!(pillEl instanceof HTMLElement) ||
		!(targetEl instanceof HTMLElement) ||
		!(rowsEl instanceof HTMLElement) ||
		!(startBtn instanceof HTMLButtonElement) ||
		!(errEl instanceof HTMLElement)
	) {
		return;
	}

	// Settings gear → the options page (sidecar URL / screenshot mode).
	const settingsBtn = document.getElementById("settings");
	if (settingsBtn instanceof HTMLButtonElement) {
		settingsBtn.addEventListener("click", () => {
			void chromeApi.runtime?.openOptionsPage?.();
		});
	}

	const config = await loadConfig(chromeApi);

	const state = (await chromeApi.runtime?.sendMessage?.({
		type: "btp:state",
	})) as StateResponse | undefined;
	const active = state?.active === true;

	// Auto-discover the sidecar: configured URL, then the tab's port + 3
	// (dev-stack convention), then the portless default 4127.
	const [tab] =
		(await chromeApi.tabs?.query({
			active: true,
			currentWindow: true,
		})) ?? [];
	const kind = classifyPage(tab?.url);
	const pattern = originPattern(tab?.url);
	const granted =
		kind === "http" && pattern
			? await (chromeApi.permissions?.contains({ origins: [pattern] }) ??
					Promise.resolve(false))
			: kind === "loopback";
	const mode = popupMode(kind, granted, active);

	const paint = (isActive: boolean): void => {
		startBtn.textContent = isActive ? "Stop capture" : "Start capture";
		startBtn.dataset.active = String(isActive);
	};

	// In-flight guard: a rapid second click while a toggle is settling would
	// race the overlay/tab state, so ignore clicks until the current one
	// resolves. Rejections surface in errEl and always restore the button.
	let toggling = false;
	const doToggle = (): Promise<void> => {
		if (toggling) return Promise.resolve();
		toggling = true;
		errEl.textContent = "";
		startBtn.disabled = true;
		return (async () => {
			try {
				const res = (await chromeApi.runtime?.sendMessage?.({
					type: "btp:toggle",
				})) as { active: boolean; error?: string } | undefined;
				if (res?.error) {
					errEl.textContent = res.error;
					return;
				}
				paint(res?.active === true);
				if (res?.active) window.close();
			} catch (err) {
				errEl.textContent =
					err instanceof Error ? err.message : "Toggle failed. Try again.";
			} finally {
				toggling = false;
				startBtn.disabled = false;
			}
		})();
	};

	if (mode === "blocked") {
		paint(false);
		startBtn.disabled = true;
		errEl.textContent =
			"BugToPrompt can't run on this page (chrome://, file://, or the Web Store).";
		return;
	}

	// Wire the primary action BEFORE the sidecar probe so capture stays usable
	// even if discovery or /health hangs — clipboard/download capture needs no
	// sidecar.
	if (mode === "enable") {
		startBtn.textContent = "Enable on this site";
		startBtn.dataset.active = "false";
		startBtn.addEventListener("click", () => {
			// Extend the same re-entry guard across permission acquisition so a
			// double-click can't launch concurrent permissions.request() calls
			// (the second rejection would otherwise go unhandled).
			if (toggling) return;
			toggling = true;
			startBtn.disabled = true;
			errEl.textContent = "";
			startBtn.disabled = true;
			void (async () => {
				let ok = false;
				try {
					if (!pattern) return;
					ok = await (chromeApi.permissions?.request({
						origins: [pattern],
					}) ?? Promise.resolve(false));
					if (!ok) {
						errEl.textContent =
							"Permission denied. BugToPrompt needs access to this site to capture.";
					}
				} catch {
					errEl.textContent =
						"Permission denied. BugToPrompt needs access to this site to capture.";
				} finally {
					toggling = false;
					startBtn.disabled = false;
				}
				// Permission granted (and persisted by Chrome) — activate now.
				// doToggle re-guards on `toggling`, released above.
				if (ok) void doToggle();
			})();
		});
	} else {
		paint(active);
		startBtn.addEventListener("click", doToggle);
	}
	startBtn.disabled = false;

	// Sidecar discovery + health decorate the pill/capability rows only; they run
	// after the button is wired so a slow endpoint never blocks capture. Each
	// probe is bounded so a stalled /health cannot freeze the popup either.
	const HEALTH_TIMEOUT_MS = 4000;
	const timedFetch: typeof fetch = (input, init) =>
		fetch(input, {
			...init,
			signal: init?.signal ?? AbortSignal.timeout(HEALTH_TIMEOUT_MS),
		});
	const { baseUrl } = await discoverBaseUrl(
		candidateBaseUrls(config.baseUrl, tab?.url),
		timedFetch,
	);
	targetEl.textContent = baseUrl;
	const health = await fetchHealth(
		baseUrl,
		timedFetch,
		HEALTH_TIMEOUT_MS,
		pageOrigin(tab?.url),
	);
	renderPill(pillEl, healthPill(health));
	renderRows(rowsEl, buildRows(config, health));
	// When the sidecar can't be reached for a bound non-localhost site, the most
	// common cause is its origin allowlist — surface the exact env fix. Never
	// clobber a newer toggle/injection error the user just triggered.
	if (
		!health?.originAllowed &&
		kind === "http" &&
		(granted || active) &&
		!errEl.textContent
	) {
		errEl.textContent = offlineHint(pageOrigin(tab?.url));
	}
}

declare const chrome: ChromeLike;
if (typeof chrome !== "undefined" && typeof document !== "undefined") {
	document.addEventListener("DOMContentLoaded", () => {
		void initPopup(chrome);
	});
}
