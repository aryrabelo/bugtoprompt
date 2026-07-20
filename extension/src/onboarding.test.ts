import { describe, expect, it, vi } from "vitest";
import type { ChromeLike } from "./config";
import {
	initOnboarding,
	isOnboardingComplete,
	liteStatus,
	markOnboardingComplete,
	proStatus,
	sanitizeProToken,
} from "./onboarding";
import type { HealthPayload } from "./popup";

function fakeChrome(): ChromeLike {
	const syncStore: Record<string, unknown> = {};
	const localStore: Record<string, unknown> = {};
	return {
		storage: {
			sync: {
				get: vi.fn(async () => ({ ...syncStore })),
				set: vi.fn(async (items: Record<string, unknown>) => {
					Object.assign(syncStore, items);
				}),
			},
			local: {
				get: vi.fn(async () => ({ ...localStore })),
				set: vi.fn(async (items: Record<string, unknown>) => {
					Object.assign(localStore, items);
				}),
			},
		},
	};
}

describe("liteStatus", () => {
	it("reports the tray as detected when health is non-null", () => {
		const health: HealthPayload = {
			ok: true,
			issues: true,
			repos: 2,
			gh: "ready",
			transcription: "ready",
			originAllowed: true,
		};
		expect(liteStatus(health)).toEqual({
			label: "Local tray detected",
			tone: "ok",
		});
	});

	it("reports no tray found when health is null", () => {
		expect(liteStatus(null)).toEqual({
			label: "No local tray found",
			tone: "down",
		});
	});
});

describe("proStatus", () => {
	it("reports an active session when true", () => {
		expect(proStatus(true)).toEqual({
			label: "Pro session active",
			tone: "ok",
		});
	});

	it("reports not signed in when false", () => {
		expect(proStatus(false)).toEqual({ label: "Not signed in", tone: "warn" });
	});
});

describe("sanitizeProToken", () => {
	it("trims surrounding whitespace", () => {
		expect(sanitizeProToken("  mykey  ")).toBe("mykey");
	});

	it("collapses whitespace-only input to an empty string", () => {
		expect(sanitizeProToken("   ")).toBe("");
	});
});

describe("markOnboardingComplete / isOnboardingComplete", () => {
	it("is false on a fresh store and true after marking complete", async () => {
		const chromeApi = fakeChrome();
		expect(await isOnboardingComplete(chromeApi)).toBe(false);
		await markOnboardingComplete(chromeApi);
		expect(await isOnboardingComplete(chromeApi)).toBe(true);
	});
});

describe("initOnboarding — DOM wiring", () => {
	function mountOnboardingDom(): void {
		document.body.innerHTML = `
			<span id="lite-status"></span>
			<p id="lite-hint"></p>
			<button id="lite-retry" type="button"></button>
			<span id="pro-status"></span>
			<button id="pro-signin" type="button"></button>
			<button id="pro-check" type="button"></button>
			<input id="pro-key" type="password" />
			<button id="pro-save" type="button"></button>
			<p id="pro-hint"></p>
			<button id="finish" type="button"></button>
			<p id="done-note"></p>
		`;
	}

	/** Drain pending microtasks (promise chains) without touching real timers
	 *  or guessing a wall-clock duration — the click handlers' async work is a
	 *  chain of native-Promise awaits with no macrotask boundary of its own. */
	async function flushMicrotasks(): Promise<void> {
		for (let i = 0; i < 30; i++) {
			await Promise.resolve();
		}
	}

	function stubFetch(): void {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				if (String(input).includes("/api/auth/get-session")) {
					return new Response(JSON.stringify({ session: { token: "tok" } }), {
						status: 200,
					});
				}
				throw new Error("no network");
			}),
		);
	}

	it("returns without throwing when the onboarding fixture is absent", async () => {
		document.body.innerHTML = "";
		await expect(initOnboarding(fakeChrome())).resolves.toBeUndefined();
	});

	it("pro-check saves the session token from fetchProSession and repaints #pro-status", async () => {
		mountOnboardingDom();
		const chromeApi = fakeChrome();
		stubFetch();
		try {
			await initOnboarding(chromeApi);
			const checkBtn = document.getElementById("pro-check");
			if (!(checkBtn instanceof HTMLButtonElement)) {
				throw new Error("pro-check button missing from fixture");
			}
			checkBtn.click();
			await flushMicrotasks();
			const local = await chromeApi.storage.local.get(["proToken"]);
			expect(local.proToken).toBe("tok");
			const statusEl = document.getElementById("pro-status");
			expect(statusEl?.textContent).toBe("Pro session active");
			expect(statusEl?.dataset.tone).toBe("ok");
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("pro-save trims and persists a pasted key", async () => {
		mountOnboardingDom();
		const chromeApi = fakeChrome();
		stubFetch();
		try {
			await initOnboarding(chromeApi);
			const keyEl = document.getElementById("pro-key");
			const saveBtn = document.getElementById("pro-save");
			if (
				!(keyEl instanceof HTMLInputElement) ||
				!(saveBtn instanceof HTMLButtonElement)
			) {
				throw new Error("pro-key/pro-save missing from fixture");
			}
			keyEl.value = "  mykey  ";
			saveBtn.click();
			await flushMicrotasks();
			const local = await chromeApi.storage.local.get(["proToken"]);
			expect(local.proToken).toBe("mykey");
			const statusEl = document.getElementById("pro-status");
			expect(statusEl?.textContent).toBe("Pro session active");
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("finish marks onboarding complete and shows the done note", async () => {
		mountOnboardingDom();
		const chromeApi = fakeChrome();
		stubFetch();
		try {
			await initOnboarding(chromeApi);
			const finishBtn = document.getElementById("finish");
			if (!(finishBtn instanceof HTMLButtonElement)) {
				throw new Error("finish button missing from fixture");
			}
			finishBtn.click();
			await flushMicrotasks();
			expect(await isOnboardingComplete(chromeApi)).toBe(true);
			expect(document.getElementById("done-note")?.textContent).toBe(
				"Setup complete. Open a localhost page and click the BugToPrompt icon to capture your first bug.",
			);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
