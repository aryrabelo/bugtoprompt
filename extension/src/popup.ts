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
export type TranscriptionState = "ready" | "unconfigured";

export interface HealthPayload {
	ok: true;
	issues: boolean;
	repos: number;
	gh: GhState;
	transcription: TranscriptionState;
}

/** Fetch and validate the sidecar /health contract. Returns null when down. */
export async function fetchHealth(
	baseUrl: string,
	fetchImpl: typeof fetch,
): Promise<HealthPayload | null> {
	let raw: unknown;
	try {
		const res = await fetchImpl(`${baseUrl}/health`);
		if (!res.ok) return null;
		raw = await res.json();
	} catch {
		return null;
	}
	if (typeof raw !== "object" || raw === null) return null;
	if (!("ok" in raw) || raw.ok !== true) return null;
	const issues = "issues" in raw && raw.issues === true;
	const repos = "repos" in raw && typeof raw.repos === "number" ? raw.repos : 0;
	const gh =
		"gh" in raw &&
		(raw.gh === "ready" || raw.gh === "missing" || raw.gh === "unauthenticated")
			? raw.gh
			: "missing";
	const transcription =
		"transcription" in raw && raw.transcription === "ready"
			? "ready"
			: "unconfigured";
	return { ok: true, issues, repos, gh, transcription };
}

export interface StatusPill {
	label: string;
	tone: "ok" | "warn" | "down";
}

export function healthPill(health: HealthPayload | null): StatusPill {
	if (!health) return { label: "Sidecar offline", tone: "down" };
	if (health.gh !== "ready") {
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
	const voiceReady = health?.transcription === "ready";
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
		: health.gh === "missing"
			? "gh CLI missing"
			: health.gh === "unauthenticated"
				? "gh not authenticated"
				: health.issues
					? `${health.repos} repo(s)`
					: "No repository configured";
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

	const { baseUrl } = await discoverBaseUrl(
		candidateBaseUrls(config.baseUrl, tab?.url),
		fetch,
	);
	targetEl.textContent = baseUrl;

	const health = await fetchHealth(baseUrl, fetch);
	renderPill(pillEl, healthPill(health));
	renderRows(rowsEl, buildRows(config, health));

	const paint = (isActive: boolean): void => {
		startBtn.textContent = isActive ? "Stop capture" : "Start capture";
		startBtn.dataset.active = String(isActive);
	};

	// When the sidecar can't be reached for a bound non-localhost site, the most
	// common cause is its origin allowlist — surface the exact env fix.
	if (!health && kind === "http" && (granted || active)) {
		errEl.textContent = offlineHint(pageOrigin(tab?.url));
	}

	const doToggle = (): void => {
		errEl.textContent = "";
		void (async () => {
			const res = (await chromeApi.runtime?.sendMessage?.({
				type: "btp:toggle",
			})) as { active: boolean; error?: string } | undefined;
			if (res?.error) {
				errEl.textContent = res.error;
				return;
			}
			paint(res?.active === true);
			if (res?.active) window.close();
		})();
	};

	if (mode === "blocked") {
		paint(false);
		startBtn.disabled = true;
		errEl.textContent =
			"BugToPrompt can't run on this page (chrome://, file://, or the Web Store).";
		return;
	}

	if (mode === "enable") {
		startBtn.textContent = "Enable on this site";
		startBtn.dataset.active = "false";
		startBtn.addEventListener("click", () => {
			errEl.textContent = "";
			void (async () => {
				if (!pattern) return;
				const ok = await (chromeApi.permissions?.request({
					origins: [pattern],
				}) ?? Promise.resolve(false));
				if (!ok) {
					errEl.textContent =
						"Permission denied. BugToPrompt needs access to this site to capture.";
					return;
				}
				// Permission granted (and persisted by Chrome) — activate now.
				doToggle();
			})();
		});
		return;
	}

	paint(active);
	startBtn.addEventListener("click", doToggle);
}

declare const chrome: ChromeLike;
if (typeof chrome !== "undefined" && typeof document !== "undefined") {
	document.addEventListener("DOMContentLoaded", () => {
		void initPopup(chrome);
	});
}
