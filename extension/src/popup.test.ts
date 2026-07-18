import { describe, expect, it, vi } from "vitest";
import { type ChromeLike, DEFAULT_CONFIG } from "./config";
import {
	buildRows,
	fetchHealth,
	fetchProSession,
	type HealthPayload,
	healthPill,
	initPopup,
	offlineHint,
	popupMode,
} from "./popup";

function jsonResponse(body: unknown, ok = true): Response {
	return {
		ok,
		json: async () => body,
	} as unknown as Response;
}

describe("fetchHealth", () => {
	it("parses the exact health contract", async () => {
		const payload: HealthPayload = {
			ok: true,
			issues: true,
			repos: 2,
			gh: "ready",
			transcription: "ready",
			originAllowed: true,
		};
		const fetchImpl = vi.fn(async () => jsonResponse(payload));
		const health = await fetchHealth(
			"http://127.0.0.1:4127",
			fetchImpl as unknown as typeof fetch,
		);
		expect(health).toEqual(payload);
		expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:4127/health");
	});

	it('parses transcription:"local" instead of treating it as sidecar offline', async () => {
		const payload: HealthPayload = {
			ok: true,
			issues: false,
			repos: 0,
			gh: "ready",
			transcription: "local",
			originAllowed: true,
		};
		const fetchImpl = vi.fn(async () => jsonResponse(payload));
		const health = await fetchHealth(
			"http://127.0.0.1:4127",
			fetchImpl as unknown as typeof fetch,
		);
		expect(health).toEqual(payload);
	});

	it("returns null when the sidecar is offline or the body is malformed", async () => {
		const down = vi.fn(async () => {
			throw new Error("ECONNREFUSED");
		});
		expect(
			await fetchHealth(
				"http://127.0.0.1:4127",
				down as unknown as typeof fetch,
			),
		).toBeNull();

		const bad = vi.fn(async () => jsonResponse({ nope: 1 }));
		expect(
			await fetchHealth(
				"http://127.0.0.1:4127",
				bad as unknown as typeof fetch,
			),
		).toBeNull();

		// ok:true but required fields missing/invalid — reject, don't invent defaults.
		const partial = vi.fn(async () => jsonResponse({ ok: true }));
		expect(
			await fetchHealth(
				"http://127.0.0.1:4127",
				partial as unknown as typeof fetch,
			),
		).toBeNull();
	});

	it("passes an abort signal when a timeout is given", async () => {
		const payload: HealthPayload = {
			ok: true,
			issues: false,
			repos: 0,
			gh: "ready",
			transcription: "unconfigured",
			originAllowed: true,
		};
		const fetchImpl = vi.fn(async () => jsonResponse(payload));
		await fetchHealth(
			"http://127.0.0.1:4127",
			fetchImpl as unknown as typeof fetch,
			2000,
		);
		const [url, opts] = fetchImpl.mock.calls[0] as unknown as [
			string,
			RequestInit?,
		];
		expect(url).toBe("http://127.0.0.1:4127/health");
		expect(opts?.signal).toBeInstanceOf(AbortSignal);
	});

	it("appends the page origin so the sidecar can report its CORS verdict", async () => {
		const fetchImpl = vi.fn(async () =>
			jsonResponse({
				ok: true,
				issues: true,
				repos: 1,
				gh: "ready",
				transcription: "ready",
				originAllowed: true,
			}),
		);
		await fetchHealth(
			"http://127.0.0.1:4127",
			fetchImpl as unknown as typeof fetch,
			undefined,
			"https://app.example.com",
		);
		expect(fetchImpl).toHaveBeenCalledWith(
			"http://127.0.0.1:4127/health?origin=https%3A%2F%2Fapp.example.com",
		);
	});

	// Root cause of the bug: /health answers before the CORS gate, so a sidecar
	// that would 403 real requests from this origin still returns a valid body.
	// fetchHealth must surface originAllowed:false (non-null) so the caller can
	// distinguish "up but wrong origin" from "down" — the old `!health` hint
	// check treated this as healthy.
	it("parses originAllowed:false without treating the sidecar as offline", async () => {
		const fetchImpl = vi.fn(async () =>
			jsonResponse({
				ok: true,
				issues: true,
				repos: 1,
				gh: "ready",
				transcription: "ready",
				originAllowed: false,
			}),
		);
		const health = await fetchHealth(
			"http://127.0.0.1:4127",
			fetchImpl as unknown as typeof fetch,
		);
		expect(health).not.toBeNull();
		expect(health?.originAllowed).toBe(false);
	});

	it("rejects a body missing the originAllowed field", async () => {
		const fetchImpl = vi.fn(async () =>
			jsonResponse({
				ok: true,
				issues: true,
				repos: 1,
				gh: "ready",
				transcription: "ready",
			}),
		);
		expect(
			await fetchHealth(
				"http://127.0.0.1:4127",
				fetchImpl as unknown as typeof fetch,
			),
		).toBeNull();
	});
});

describe("fetchProSession", () => {
	it("returns the session token on a valid session body", async () => {
		const fetchImpl = vi.fn(async () =>
			jsonResponse({ session: { token: "t" } }),
		);
		const token = await fetchProSession(
			"https://api.bugtoprompt.com",
			fetchImpl as unknown as typeof fetch,
		);
		expect(token).toBe("t");
		const [url, init] = fetchImpl.mock.calls[0] as unknown as [
			string,
			RequestInit,
		];
		expect(url).toBe("https://api.bugtoprompt.com/api/auth/get-session");
		expect(init.credentials).toBe("include");
	});

	it("returns null on a non-ok response", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({}, false));
		const token = await fetchProSession(
			"https://api.bugtoprompt.com",
			fetchImpl as unknown as typeof fetch,
		);
		expect(token).toBeNull();
	});

	it("returns null when the session or token is missing/empty", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({}));
		expect(
			await fetchProSession(
				"https://api.bugtoprompt.com",
				fetchImpl as unknown as typeof fetch,
			),
		).toBeNull();

		const emptyToken = vi.fn(async () =>
			jsonResponse({ session: { token: "" } }),
		);
		expect(
			await fetchProSession(
				"https://api.bugtoprompt.com",
				emptyToken as unknown as typeof fetch,
			),
		).toBeNull();
	});

	it("returns null on a network error instead of throwing", async () => {
		const fetchImpl = vi.fn(async () => {
			throw new Error("offline");
		});
		const token = await fetchProSession(
			"https://api.bugtoprompt.com",
			fetchImpl as unknown as typeof fetch,
		);
		expect(token).toBeNull();
	});
});

describe("healthPill", () => {
	it("maps health state to a status tone", () => {
		expect(healthPill(null).tone).toBe("down");
		expect(
			healthPill({
				ok: true,
				issues: true,
				repos: 0,
				gh: "unauthenticated",
				transcription: "unconfigured",
				originAllowed: true,
			}).tone,
		).toBe("warn");
		// Issue filing disabled → gh irrelevant, not flagged as unhealthy.
		expect(
			healthPill({
				ok: true,
				issues: false,
				repos: 0,
				gh: "missing",
				transcription: "unconfigured",
				originAllowed: true,
			}).tone,
		).toBe("ok");
		expect(
			healthPill({
				ok: true,
				issues: true,
				repos: 1,
				gh: "ready",
				transcription: "ready",
				originAllowed: true,
			}).tone,
		).toBe("ok");
	});
});

describe("buildRows", () => {
	it("reflects onClick capture, armed voice, and a ready repo", () => {
		const rows = buildRows(DEFAULT_CONFIG, {
			ok: true,
			issues: true,
			repos: 3,
			gh: "ready",
			transcription: "ready",
			originAllowed: true,
		});
		const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
		expect(byKey.capture.status).toBe("On every click");
		expect(byKey.capture.ready).toBe(true);
		expect(byKey.voice.status).toBe("Ready Cloud");
		expect(byKey.voice.ready).toBe(true);
		expect(byKey.issue.status).toBe("3 repo(s)");
		expect(byKey.issue.ready).toBe(true);
	});

	it('treats transcription:"local" as voice-ready and distinguishes it from cloud in the status text', () => {
		const rows = buildRows(DEFAULT_CONFIG, {
			ok: true,
			issues: false,
			repos: 0,
			gh: "ready",
			transcription: "local",
			originAllowed: true,
		});
		const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
		expect(byKey.voice.ready).toBe(true);
		expect(byKey.voice.status).toBe("Ready Local");
		expect(byKey.voice.status).not.toBe("Not configured");

		const cloudRows = buildRows(DEFAULT_CONFIG, {
			ok: true,
			issues: false,
			repos: 0,
			gh: "ready",
			transcription: "ready",
			originAllowed: true,
		});
		const cloudByKey = Object.fromEntries(cloudRows.map((r) => [r.key, r]));
		expect(cloudByKey.voice.status).toBe("Ready Cloud");
		expect(cloudByKey.voice.status).not.toBe(byKey.voice.status);
	});

	it("degrades gracefully when the sidecar is offline", () => {
		const rows = buildRows(DEFAULT_CONFIG, null);
		const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
		expect(byKey.voice.status).toBe("Sidecar offline");
		expect(byKey.voice.ready).toBe(false);
		expect(byKey.issue.ready).toBe(false);
	});

	it("surfaces gh states for the issue row when filing is enabled", () => {
		const missing = buildRows(DEFAULT_CONFIG, {
			ok: true,
			issues: true,
			repos: 0,
			gh: "missing",
			transcription: "unconfigured",
			originAllowed: true,
		});
		expect(missing.find((r) => r.key === "issue")?.status).toBe(
			"gh CLI missing",
		);
	});

	it("labels disabled issue filing instead of a gh/repo fault", () => {
		const disabled = buildRows(DEFAULT_CONFIG, {
			ok: true,
			issues: false,
			repos: 0,
			gh: "missing",
			transcription: "unconfigured",
			originAllowed: true,
		});
		const row = disabled.find((r) => r.key === "issue");
		expect(row?.status).toBe("Issue filing disabled");
		expect(row?.ready).toBe(false);
	});
});

describe("popupMode", () => {
	it("toggles loopback pages and active tabs directly", () => {
		expect(popupMode("loopback", true, false)).toBe("toggle");
		expect(popupMode("http", false, true)).toBe("toggle");
		expect(popupMode("protected", false, true)).toBe("toggle");
	});

	it("offers enable on an ungranted http site, toggle once granted", () => {
		expect(popupMode("http", false, false)).toBe("enable");
		expect(popupMode("http", true, false)).toBe("toggle");
	});

	it("blocks protected and invalid pages", () => {
		expect(popupMode("protected", false, false)).toBe("blocked");
		expect(popupMode("invalid", false, false)).toBe("blocked");
	});
});

describe("offlineHint", () => {
	it("names the sidecar origin allowlist for a bound site", () => {
		const hint = offlineHint("https://app.example.com");
		expect(hint).toContain(
			"BUGTOPROMPT_ALLOWED_ORIGINS=https://app.example.com",
		);
	});

	it("falls back to a generic message without an origin", () => {
		expect(offlineHint(undefined)).toMatch(/Sidecar offline/);
	});
});

describe("initPopup — pro button (DOM wiring)", () => {
	function mountPopupDom(): void {
		document.body.innerHTML = `
			<span id="status-pill"></span>
			<p id="target"></p>
			<section id="rows"></section>
			<button id="start" type="button"></button>
			<div class="pro">
				<button id="pro-login" type="button">Login to Pro</button>
				<span id="pro-hint"></span>
			</div>
			<p id="error"></p>
		`;
	}

	/** Drain pending microtasks (promise chains) without touching real timers
	 *  or guessing a wall-clock duration — the click handler's async work is
	 *  a chain of native-Promise awaits with no macrotask boundary of its own. */
	async function flushMicrotasks(): Promise<void> {
		for (let i = 0; i < 30; i++) {
			await Promise.resolve();
		}
	}

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
			// A loopback tab so popupMode resolves to "toggle" (never "blocked",
			// which would return before the pro button is wired at all).
			tabs: {
				query: vi.fn(async () => [{ id: 1, url: "http://localhost:3000/" }]),
			},
		};
	}

	it("shows a retry hint and leaves no unhandled rejection when saveConfig rejects mid pro-login (P2)", async () => {
		mountPopupDom();
		const chromeApi = fakeChrome();
		// fetchProSession succeeds (so the click handler reaches saveConfig);
		// every other request (sidecar discovery/health) fails harmlessly —
		// both fetchHealth and discoverBaseUrl already tolerate that.
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				if (String(input).includes("/api/auth/get-session")) {
					return new Response(
						JSON.stringify({ session: { token: "new-token" } }),
						{ status: 200 },
					);
				}
				throw new Error("no network");
			}),
		);
		// The saveConfig() the click handler awaits ends in storage.local.set —
		// reject exactly that call to exercise the failure path.
		vi.mocked(chromeApi.storage.local.set).mockRejectedValueOnce(
			new Error("disk full"),
		);
		const onUnhandledRejection = vi.fn();
		process.on("unhandledRejection", onUnhandledRejection);
		try {
			await initPopup(chromeApi);
			const proBtn = document.getElementById("pro-login");
			if (!(proBtn instanceof HTMLButtonElement)) {
				throw new Error("pro-login button missing from fixture");
			}
			proBtn.click();
			// Flush the click handler's async IIFE (fetchProSession → saveConfig →
			// reject → finally → .catch) past its microtask chain.
			await flushMicrotasks();
			const hintEl = document.getElementById("pro-hint");
			expect(hintEl?.textContent).toBe(
				"Couldn't update the Pro session — try again.",
			);
			// finally still released the button regardless of the rejection.
			expect(proBtn.disabled).toBe(false);
		} finally {
			process.off("unhandledRejection", onUnhandledRejection);
			vi.unstubAllGlobals();
		}
		expect(onUnhandledRejection).not.toHaveBeenCalled();
	});
});
