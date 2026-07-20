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
	PRO_BASE_URL,
	PRO_LOGIN_URL,
	pageOrigin,
	saveConfig,
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

/** Validate an already-parsed /health body against the exact contract. Shared
 *  by fetchHealth (full probe) and classifyTray (tray-state probe) so both
 *  paths reject the same malformed shapes. */
export function parseHealthPayload(
	r: Record<string, unknown>,
): HealthPayload | null {
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
				timer = window.setTimeout(() => ctrl.abort(), timeoutMs);
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
			window.clearTimeout(timer);
		}
	} catch {
		return null;
	}
	if (typeof raw !== "object" || raw === null) return null;
	return parseHealthPayload(raw as Record<string, unknown>);
}

/**
 * Better Auth session probe (PRO): the user logs in on the PRO dashboard; the
 * extension picks the resulting session up from cookies. Returns the session
 * token, or null when logged out, offline, or the body is malformed — never
 * throws.
 */
export async function fetchProSession(
	baseUrl: string,
	fetchImpl: typeof fetch,
	timeoutMs = 4000,
): Promise<string | null> {
	try {
		const res = await fetchImpl(`${baseUrl}/api/auth/get-session`, {
			credentials: "include",
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!res.ok) return null;
		const body = (await res.json()) as { session?: { token?: unknown } };
		const token = body.session?.token;
		return typeof token === "string" && token !== "" ? token : null;
	} catch {
		return null;
	}
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
	const voiceMode =
		health?.transcription === "local"
			? config.autoVoice
				? "Ready Local"
				: "Ready Local · manual"
			: config.autoVoice
				? "Ready Cloud"
				: "Ready Cloud · manual";
	const voiceStatus = !health
		? "Sidecar offline"
		: voiceReady
			? voiceMode
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
// Tray state (issue #99) — distinguish "no tray installed" from "tray
// installed but unreachable" from "tray installed but too old to trust", so
// the popup can point the user at the right fix instead of one generic
// "Sidecar offline" pill. See the shared contract in sidecar-rust's /health
// handler: a version-less body predates this contract and counts as outdated.
// ---------------------------------------------------------------------------

/** GitHub release page offering the current tray build. */
export const RELEASES_URL =
	"https://github.com/aryrabelo/bugtoprompt/releases/latest";
/** The tray release at which /health started reporting `version`. A body
 *  missing `version` predates this contract and is therefore outdated. */
export const MIN_TRAY_VERSION = "0.1.0";

/** Parse a `vMAJOR.MINOR.PATCH` (or shorter `vMAJOR[.MINOR]`) string into a
 *  comparable triple, mirroring sidecar-rust/src/updater.rs's parse_version:
 *  a leading `v` and any pre-release/build suffix (`-rc.1`, `+meta`) are
 *  dropped; a non-numeric or missing major segment, or a fourth component,
 *  fails parsing. */
export function parseVersion(s: string): [number, number, number] | null {
	const core = s.trim().replace(/^v+/, "");
	const withoutSuffix = core.split(/[-+]/)[0] ?? "";
	const parts = withoutSuffix.split(".");
	if (parts.length > 3 || parts[0] === "") return null;
	const [major, minor, patch] = [
		parts[0],
		parts[1] ?? "0",
		parts[2] ?? "0",
	].map(Number);
	if (
		!Number.isFinite(major) ||
		!Number.isFinite(minor) ||
		!Number.isFinite(patch)
	) {
		return null;
	}
	return [major, minor, patch];
}

/** True iff `candidate` parses to a version >= `min`. False if either side
 *  fails to parse (never treat garbage as "up to date"). */
export function isVersionAtLeast(candidate: string, min: string): boolean {
	const c = parseVersion(candidate);
	const m = parseVersion(min);
	if (!c || !m) return false;
	for (let i = 0; i < 3; i++) {
		if (c[i] !== m[i]) return c[i] > m[i];
	}
	return true;
}

/** Raw outcome of a single GET {baseUrl}/health probe, before the tray
 *  contract (version, ok, etc.) is interpreted. */
export type TrayProbe =
	| { transport: "neterror" }
	| { transport: "timeout" }
	| { transport: "http-error"; status: number }
	| { transport: "ok"; body: unknown };

/** Probe /health without decoding the health contract — classifyTray decides
 *  whether the tray is missing, outdated, unreachable, or ready. Reuses
 *  fetchHealth's bounded-signal pattern so a hung tray never hangs the popup. */
export async function probeTray(
	baseUrl: string,
	fetchImpl: typeof fetch,
	timeoutMs?: number,
	origin?: string,
): Promise<TrayProbe> {
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
			timer = window.setTimeout(() => ctrl.abort(), timeoutMs);
			signal = ctrl.signal;
		}
	}
	let res: Response;
	try {
		const url = origin
			? `${baseUrl}/health?origin=${encodeURIComponent(origin)}`
			: `${baseUrl}/health`;
		res = await (signal ? fetchImpl(url, { signal }) : fetchImpl(url));
	} catch (err) {
		// AbortSignal.timeout() rejects with a "TimeoutError" DOMException, while
		// a manual AbortController.abort() (older-Chrome fallback) rejects with
		// "AbortError" — both mean the tray was listening-or-slow, not absent, so
		// map either to "timeout". Any other throw is a connection failure.
		const name = (err as Error)?.name;
		return name === "AbortError" || name === "TimeoutError"
			? { transport: "timeout" }
			: { transport: "neterror" };
	} finally {
		window.clearTimeout(timer);
	}
	if (!res.ok) return { transport: "http-error", status: res.status };
	try {
		const body = await res.json();
		return { transport: "ok", body };
	} catch {
		return { transport: "ok", body: undefined };
	}
}

export type TrayStatusKind =
	| "ready"
	| "outdated"
	| "unreachable"
	| "not-installed";

export interface TrayStatus {
	kind: TrayStatusKind;
	health: HealthPayload | null;
	version: string | null;
}

/** Classify a probe into one of the four popup-visible tray states per the
 *  shared contract: connection refused means no tray is running at all,
 *  while a timeout or non-2xx means one IS listening but not answering
 *  cleanly — those get different copy (install vs. restart). */
export function classifyTray(probe: TrayProbe): TrayStatus {
	if (probe.transport === "neterror") {
		return { kind: "not-installed", health: null, version: null };
	}
	if (probe.transport === "timeout" || probe.transport === "http-error") {
		return { kind: "unreachable", health: null, version: null };
	}
	const body = probe.body;
	if (typeof body !== "object" || body === null) {
		return { kind: "unreachable", health: null, version: null };
	}
	const r = body as Record<string, unknown>;
	if (r.ok !== true) {
		return { kind: "unreachable", health: null, version: null };
	}
	const version = typeof r.version === "string" ? r.version : null;
	const health = parseHealthPayload(r);
	if (version === null || !isVersionAtLeast(version, MIN_TRAY_VERSION)) {
		return { kind: "outdated", health, version };
	}
	return { kind: "ready", health, version };
}

export function trayPill(status: TrayStatus): StatusPill {
	switch (status.kind) {
		case "ready":
			return healthPill(status.health);
		case "outdated":
			return { label: "Tray outdated", tone: "warn" };
		case "unreachable":
			return { label: "Tray unreachable", tone: "down" };
		case "not-installed":
			return { label: "Tray not installed", tone: "down" };
	}
}

export interface TrayAction {
	title: string;
	hint: string;
	url?: string;
}

/** Actionable call-out for a non-ready tray state, or null when ready (no
 *  action needed). `url` is present only when there's something to download —
 *  "unreachable" means a tray IS installed, so a restart is the fix, not a
 *  download. */
export function trayAction(status: TrayStatus): TrayAction | null {
	switch (status.kind) {
		case "not-installed":
			return {
				title: "Install BugToPrompt",
				hint: "Install the BugToPrompt tray, then reopen this popup.",
				url: RELEASES_URL,
			};
		case "outdated":
			return {
				title: "Update BugToPrompt",
				hint: `Your tray${status.version ? ` (v${status.version})` : ""} is out of date. Update to keep capture working.`,
				url: RELEASES_URL,
			};
		case "unreachable":
			return {
				title: "Restart the tray",
				hint: "The tray is installed but not responding on 127.0.0.1:4127. Restart it, then reopen this popup.",
			};
		case "ready":
			return null;
	}
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

/** Render (or clear) the tray-state call-out. Exported for direct testing —
 *  unlike renderPill/renderRows, its branching (CTA vs. no CTA) is worth
 *  covering without going through the full initPopup DOM flow. */
export function renderTrayAction(
	el: HTMLElement,
	action: TrayAction | null,
): void {
	if (!action) {
		el.replaceChildren();
		el.hidden = true;
		return;
	}
	const title = document.createElement("span");
	title.className = "tray-action-title";
	title.textContent = action.title;
	const hint = document.createElement("span");
	hint.className = "tray-action-hint";
	hint.textContent = action.hint;
	const children: HTMLElement[] = [title, hint];
	if (action.url) {
		const cta = document.createElement("a");
		cta.className = "tray-action-cta";
		cta.href = action.url;
		cta.target = "_blank";
		cta.rel = "noopener noreferrer";
		cta.textContent = action.title;
		children.push(cta);
	}
	el.replaceChildren(...children);
	el.dataset.kind = action.url ? "cta" : "info";
	el.hidden = false;
}

export async function initPopup(chromeApi: ChromeLike): Promise<void> {
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

	// PRO (issue #8): a stored session token routes the seeded overlay's
	// backend traffic to the remote service instead of the local sidecar.
	// Wired after the start button so a stalled probe never blocks capture;
	// skipped silently when the row is absent (jsdom / options-less builds).
	const proBtn = document.getElementById("pro-login");
	const proHintEl = document.getElementById("pro-hint");
	if (proBtn instanceof HTMLButtonElement && proHintEl instanceof HTMLElement) {
		let proToken = config.proToken;
		const paintPro = (): void => {
			proBtn.textContent = proToken ? "Pro: active · Log out" : "Login to Pro";
		};
		paintPro();
		let proBusy = false;
		proBtn.addEventListener("click", () => {
			if (proBusy) return;
			proBusy = true;
			proBtn.disabled = true;
			proHintEl.textContent = "";
			void (async () => {
				try {
					if (proToken) {
						await saveConfig(chromeApi, { proToken: "" });
						proToken = "";
						paintPro();
						return;
					}
					const token = await fetchProSession(PRO_BASE_URL, fetch);
					if (token) {
						await saveConfig(chromeApi, { proToken: token });
						proToken = token;
						paintPro();
					} else {
						void chromeApi.tabs?.create?.({ url: PRO_LOGIN_URL });
						proHintEl.textContent =
							"Log in on the dashboard, then click again.";
					}
				} finally {
					proBusy = false;
					proBtn.disabled = false;
				}
			})().catch(() => {
				// saveConfig/fetchProSession rejected (e.g. storage.local.set
				// threw): the finally above already released proBusy/disabled, so
				// this only needs to surface the failure instead of leaving no
				// feedback and an unhandled rejection.
				proHintEl.textContent = "Couldn't update the Pro session — try again.";
			});
		});
	}

	// Sidecar discovery + tray probe decorate the pill/capability rows/action
	// call-out only; they run after the button is wired so a slow endpoint
	// never blocks capture. probeTray is bounded so a stalled tray cannot
	// freeze the popup either.
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
	const probe = await probeTray(
		baseUrl,
		timedFetch,
		HEALTH_TIMEOUT_MS,
		pageOrigin(tab?.url),
	);
	const status = classifyTray(probe);
	renderPill(pillEl, trayPill(status));
	renderRows(rowsEl, buildRows(config, status.health));
	const trayActionEl = document.getElementById("tray-action");
	if (trayActionEl instanceof HTMLElement) {
		renderTrayAction(trayActionEl, trayAction(status));
	}
	// When the sidecar can't be reached for a bound non-localhost site, the most
	// common cause is its origin allowlist — surface the exact env fix. Never
	// clobber a newer toggle/injection error the user just triggered.
	if (
		!status.health?.originAllowed &&
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
