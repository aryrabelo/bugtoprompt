/**
 * Onboarding page — a guided first-run walkthrough for the BugToPrompt
 * extension. Opened once on install; detects the local Lite tray, offers
 * Pro sign-in, and walks to the first capture. Dependency-free DOM; pure
 * model helpers are exported for tests.
 */

import type { ChromeLike } from "./config";
import {
	candidateBaseUrls,
	discoverBaseUrl,
	loadConfig,
	PRO_BASE_URL,
	PRO_LOGIN_URL,
	saveConfig,
} from "./config";
import { fetchHealth, fetchProSession, type HealthPayload } from "./popup";

/** Step-1 status: is the local Lite tray/sidecar reachable? */
export function liteStatus(health: HealthPayload | null): {
	label: string;
	tone: "ok" | "down";
} {
	return health
		? { label: "Local tray detected", tone: "ok" }
		: { label: "No local tray found", tone: "down" };
}

/** Step-2 status: does the user have an active Pro session or saved key? */
export function proStatus(active: boolean): {
	label: string;
	tone: "ok" | "warn";
} {
	return active
		? { label: "Pro session active", tone: "ok" }
		: { label: "Not signed in", tone: "warn" };
}

/** Normalize a pasted Pro key: trim surrounding whitespace only. */
export function sanitizeProToken(raw: string): string {
	return raw.trim();
}

/** Mark first-run onboarding done so it never reopens itself later. */
export async function markOnboardingComplete(
	chromeApi: ChromeLike,
): Promise<void> {
	await chromeApi.storage.local.set({ onboardingComplete: true });
}

/** Has the user already finished onboarding? */
export async function isOnboardingComplete(
	chromeApi: ChromeLike,
): Promise<boolean> {
	const raw = await chromeApi.storage.local.get(["onboardingComplete"]);
	return raw?.onboardingComplete === true;
}

// ---------------------------------------------------------------------------
// DOM wiring (skipped under jsdom/tests where there is no onboarding document)
// ---------------------------------------------------------------------------

function renderStatus(
	el: HTMLElement,
	status: { label: string; tone: string },
): void {
	el.textContent = status.label;
	el.dataset.tone = status.tone;
}

export async function initOnboarding(chromeApi: ChromeLike): Promise<void> {
	const liteStatusEl = document.getElementById("lite-status");
	const liteHintEl = document.getElementById("lite-hint");
	const liteRetryBtn = document.getElementById("lite-retry");
	const proStatusEl = document.getElementById("pro-status");
	const proSigninBtn = document.getElementById("pro-signin");
	const proCheckBtn = document.getElementById("pro-check");
	const proKeyEl = document.getElementById("pro-key");
	const proSaveBtn = document.getElementById("pro-save");
	const proHintEl = document.getElementById("pro-hint");
	const finishBtn = document.getElementById("finish");
	const doneNoteEl = document.getElementById("done-note");
	if (
		!(liteStatusEl instanceof HTMLElement) ||
		!(liteHintEl instanceof HTMLElement) ||
		!(liteRetryBtn instanceof HTMLButtonElement) ||
		!(proStatusEl instanceof HTMLElement) ||
		!(proSigninBtn instanceof HTMLButtonElement) ||
		!(proCheckBtn instanceof HTMLButtonElement) ||
		!(proKeyEl instanceof HTMLInputElement) ||
		!(proSaveBtn instanceof HTMLButtonElement) ||
		!(proHintEl instanceof HTMLElement) ||
		!(finishBtn instanceof HTMLButtonElement) ||
		!(doneNoteEl instanceof HTMLElement)
	) {
		return;
	}

	const config = await loadConfig(chromeApi);

	// Bound the sidecar probes so a hung tray never freezes the walkthrough.
	const HEALTH_TIMEOUT_MS = 4000;
	const timedFetch: typeof fetch = (input, init) =>
		fetch(input, {
			...init,
			signal: init?.signal ?? AbortSignal.timeout(HEALTH_TIMEOUT_MS),
		});

	// Step 1: local tray/sidecar (Lite) detection.
	let liteChecking = false;
	const detectLite = async (): Promise<void> => {
		if (liteChecking) return;
		liteChecking = true;
		liteRetryBtn.disabled = true;
		try {
			const { baseUrl } = await discoverBaseUrl(
				candidateBaseUrls(config.baseUrl, undefined),
				timedFetch,
			);
			const health = await fetchHealth(baseUrl, timedFetch, HEALTH_TIMEOUT_MS);
			renderStatus(liteStatusEl, liteStatus(health));
			liteHintEl.textContent = health
				? ""
				: "Start the BugToPrompt tray/sidecar on this machine, then check again.";
		} finally {
			liteChecking = false;
			liteRetryBtn.disabled = false;
		}
	};
	liteRetryBtn.addEventListener("click", () => {
		void detectLite();
	});
	// Kick the Lite probe off in the background so a slow or unreachable tray
	// never blocks wiring of the Pro and Finish steps below.
	void detectLite();

	// Step 2: Pro (cloud) sign-in.
	let proActive = Boolean(config.proToken);
	renderStatus(proStatusEl, proStatus(proActive));

	proSigninBtn.addEventListener("click", () => {
		void chromeApi.tabs?.create?.({ url: PRO_LOGIN_URL });
		proHintEl.textContent = 'Sign in on the dashboard, then click "check".';
	});

	// pro-check (dashboard session) and pro-save (pasted key) both write
	// proToken, so they are mutually exclusive: a shared guard disables BOTH
	// while either is in flight, otherwise the slower request's token would
	// clobber the credential the user actually chose.
	let proBusy = false;
	const setProBusy = (busy: boolean): void => {
		proBusy = busy;
		proCheckBtn.disabled = busy;
		proSaveBtn.disabled = busy;
	};
	proCheckBtn.addEventListener("click", () => {
		if (proBusy) return;
		setProBusy(true);
		void (async () => {
			try {
				const token = await fetchProSession(PRO_BASE_URL, fetch);
				if (token) {
					await saveConfig(chromeApi, { proToken: token });
					proActive = true;
					renderStatus(proStatusEl, proStatus(proActive));
					proHintEl.textContent = "Pro session saved.";
				} else {
					proHintEl.textContent = "No session found yet — sign in first.";
				}
			} catch {
				proHintEl.textContent = "Could not check the session — try again.";
			} finally {
				setProBusy(false);
			}
		})();
	});

	proSaveBtn.addEventListener("click", () => {
		if (proBusy) return;
		setProBusy(true);
		void (async () => {
			try {
				const key = sanitizeProToken(proKeyEl.value);
				if (!key) {
					proHintEl.textContent = "Paste your Pro key first.";
					return;
				}
				await saveConfig(chromeApi, { proToken: key });
				proActive = true;
				renderStatus(proStatusEl, proStatus(proActive));
				proHintEl.textContent = "Pro key saved.";
			} catch {
				proHintEl.textContent = "Could not save the key — try again.";
			} finally {
				setProBusy(false);
			}
		})();
	});

	// Step 3: first capture.
	finishBtn.addEventListener("click", () => {
		finishBtn.disabled = true;
		void (async () => {
			try {
				await markOnboardingComplete(chromeApi);
				doneNoteEl.textContent =
					"Setup complete. Open a localhost page and click the BugToPrompt icon to capture your first bug.";
			} catch {
				doneNoteEl.textContent = "Could not save — try again.";
				finishBtn.disabled = false;
			}
		})();
	});
}

declare const chrome: ChromeLike;
if (typeof chrome !== "undefined" && typeof document !== "undefined") {
	document.addEventListener("DOMContentLoaded", () => {
		void initOnboarding(chrome);
	});
}
