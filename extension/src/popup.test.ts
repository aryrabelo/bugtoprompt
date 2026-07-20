import { describe, expect, it, vi } from "vitest";
import { type ChromeLike, DEFAULT_CONFIG } from "./config";
import {
	buildRows,
	classifyTray,
	fetchHealth,
	fetchProSession,
	type HealthPayload,
	healthPill,
	initPopup,
	isVersionAtLeast,
	MIN_TRAY_VERSION,
	offlineHint,
	parseVersion,
	popupMode,
	probeTray,
	RELEASES_URL,
	renderTrayAction,
	trayAction,
	trayPill,
} from "./popup";

function jsonResponse(body: unknown, ok = true): Response {
	return {
		ok,
		json: async () => body,
	} as unknown as Response;
}

/** Popup DOM fixture. `trayAction` mirrors popup.html's `#tray-action`
 *  section — omitted by default so existing tests keep exercising the
 *  "no such element" guard in initPopup. */
function mountPopupDom(opts?: { trayAction?: boolean }): void {
	document.body.innerHTML = `
		<span id="status-pill"></span>
		<p id="target"></p>
		<section id="rows"></section>
		${opts?.trayAction ? '<section id="tray-action"></section>' : ""}
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
		// which would return before the pro button/tray probe are wired at all).
		tabs: {
			query: vi.fn(async () => [{ id: 1, url: "http://localhost:3000/" }]),
		},
	};
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

describe("parseVersion / isVersionAtLeast", () => {
	it("parses vMAJOR.MINOR.PATCH with or without a leading v, filling missing parts with 0", () => {
		expect(parseVersion("0.1.0")).toEqual([0, 1, 0]);
		expect(parseVersion("v0.1.0")).toEqual([0, 1, 0]);
		expect(parseVersion("v2")).toEqual([2, 0, 0]);
		expect(parseVersion("1.4")).toEqual([1, 4, 0]);
	});

	it("drops pre-release/build suffixes", () => {
		expect(parseVersion("v1.2.3-rc.1")).toEqual([1, 2, 3]);
		expect(parseVersion("1.2.3+build.7")).toEqual([1, 2, 3]);
	});

	it("rejects unparseable or over-long version strings", () => {
		expect(parseVersion("latest")).toBeNull();
		expect(parseVersion("")).toBeNull();
		expect(parseVersion("v.x.y")).toBeNull();
		expect(parseVersion("1.2.3.4")).toBeNull();
	});

	it("compares candidate >= min tuple-wise", () => {
		expect(isVersionAtLeast("0.1.0", "0.1.0")).toBe(true);
		expect(isVersionAtLeast("0.2.0", "0.1.0")).toBe(true);
		expect(isVersionAtLeast("0.0.9", "0.1.0")).toBe(false);
		expect(isVersionAtLeast("garbage", "0.1.0")).toBe(false);
		expect(isVersionAtLeast("v0.1.0", "0.1.0")).toBe(true);
	});
});

describe("classifyTray", () => {
	const fullPayload = {
		ok: true,
		issues: true,
		repos: 2,
		gh: "ready",
		transcription: "ready",
		originAllowed: true,
	};

	it("treats a connection error as not-installed (no tray listening at all)", () => {
		expect(classifyTray({ transport: "neterror" })).toEqual({
			kind: "not-installed",
			health: null,
			version: null,
		});
	});

	it("treats a timeout as unreachable (a tray IS listening, just not answering)", () => {
		expect(classifyTray({ transport: "timeout" })).toEqual({
			kind: "unreachable",
			health: null,
			version: null,
		});
	});

	it("treats an HTTP error status as unreachable", () => {
		expect(classifyTray({ transport: "http-error", status: 500 })).toEqual({
			kind: "unreachable",
			health: null,
			version: null,
		});
	});

	it("treats a 2xx body with ok:false as unreachable", () => {
		expect(classifyTray({ transport: "ok", body: { ok: false } })).toEqual({
			kind: "unreachable",
			health: null,
			version: null,
		});
	});

	it("treats a non-object body as unreachable", () => {
		expect(classifyTray({ transport: "ok", body: "nope" })).toEqual({
			kind: "unreachable",
			health: null,
			version: null,
		});
		expect(classifyTray({ transport: "ok", body: null })).toEqual({
			kind: "unreachable",
			health: null,
			version: null,
		});
	});

	it("treats a full payload at MIN_TRAY_VERSION as ready", () => {
		const status = classifyTray({
			transport: "ok",
			body: { ...fullPayload, version: MIN_TRAY_VERSION },
		});
		expect(status.kind).toBe("ready");
		expect(status.version).toBe(MIN_TRAY_VERSION);
		expect(status.health).not.toBeNull();
	});

	it("treats a full payload with no version as outdated (predates the version contract)", () => {
		const status = classifyTray({ transport: "ok", body: fullPayload });
		expect(status.kind).toBe("outdated");
		expect(status.version).toBeNull();
		expect(status.health).not.toBeNull();
	});

	it("treats a full payload below MIN_TRAY_VERSION as outdated", () => {
		const status = classifyTray({
			transport: "ok",
			body: { ...fullPayload, version: "0.0.1" },
		});
		expect(status.kind).toBe("outdated");
		expect(status.version).toBe("0.0.1");
		expect(status.health).not.toBeNull();
	});

	it("treats a degraded (token-gated) body at MIN_TRAY_VERSION as ready with no health", () => {
		const status = classifyTray({
			transport: "ok",
			body: { ok: true, version: MIN_TRAY_VERSION },
		});
		expect(status).toEqual({
			kind: "ready",
			health: null,
			version: MIN_TRAY_VERSION,
		});
	});

	it("treats a degraded body with no version as outdated", () => {
		const status = classifyTray({ transport: "ok", body: { ok: true } });
		expect(status).toEqual({ kind: "outdated", health: null, version: null });
	});
});

describe("probeTray", () => {
	it("maps an AbortSignal.timeout rejection (TimeoutError) to timeout, not neterror", async () => {
		// AbortSignal.timeout() aborts with a TimeoutError DOMException — the real
		// Chrome 124+ path. A slow/hung tray must classify as unreachable, so the
		// probe must report "timeout" here, not "neterror" (which is not-installed).
		const fetchImpl = vi.fn(async () => {
			throw new DOMException("The operation timed out.", "TimeoutError");
		});
		const probe = await probeTray(
			"http://127.0.0.1:4127",
			fetchImpl as unknown as typeof fetch,
			10,
		);
		expect(probe).toEqual({ transport: "timeout" });
		expect(classifyTray(probe).kind).toBe("unreachable");
	});

	it("maps a manual AbortError to timeout too (older-Chrome fallback)", async () => {
		const fetchImpl = vi.fn(async () => {
			throw new DOMException("Aborted.", "AbortError");
		});
		const probe = await probeTray(
			"http://127.0.0.1:4127",
			fetchImpl as unknown as typeof fetch,
		);
		expect(probe).toEqual({ transport: "timeout" });
	});

	it("maps a plain connection failure to neterror (nothing listening)", async () => {
		const fetchImpl = vi.fn(async () => {
			throw new TypeError("Failed to fetch");
		});
		const probe = await probeTray(
			"http://127.0.0.1:4127",
			fetchImpl as unknown as typeof fetch,
		);
		expect(probe).toEqual({ transport: "neterror" });
		expect(classifyTray(probe).kind).toBe("not-installed");
	});

	it("maps a non-2xx response to http-error and a bad body to ok/undefined", async () => {
		const err = vi.fn(async () => ({ ok: false, status: 503 }) as Response);
		expect(
			await probeTray("http://127.0.0.1:4127", err as unknown as typeof fetch),
		).toEqual({ transport: "http-error", status: 503 });
		const badBody = vi.fn(
			async () =>
				({
					ok: true,
					status: 200,
					json: async () => {
						throw new SyntaxError("bad json");
					},
				}) as unknown as Response,
		);
		expect(
			await probeTray(
				"http://127.0.0.1:4127",
				badBody as unknown as typeof fetch,
			),
		).toEqual({ transport: "ok", body: undefined });
	});
});

describe("trayPill", () => {
	it("delegates to healthPill when ready", () => {
		const ghNotReady: HealthPayload = {
			ok: true,
			issues: true,
			repos: 0,
			gh: "unauthenticated",
			transcription: "unconfigured",
			originAllowed: true,
		};
		expect(
			trayPill({ kind: "ready", health: ghNotReady, version: "0.1.0" }),
		).toEqual({ label: "Sidecar up · gh not ready", tone: "warn" });
		expect(trayPill({ kind: "ready", health: null, version: "0.1.0" })).toEqual(
			{ label: "Sidecar offline", tone: "down" },
		);
	});

	it("labels each non-ready kind with a distinct pill", () => {
		expect(
			trayPill({ kind: "outdated", health: null, version: "0.0.1" }),
		).toEqual({ label: "Tray outdated", tone: "warn" });
		expect(
			trayPill({ kind: "unreachable", health: null, version: null }),
		).toEqual({ label: "Tray unreachable", tone: "down" });
		expect(
			trayPill({ kind: "not-installed", health: null, version: null }),
		).toEqual({ label: "Tray not installed", tone: "down" });
	});
});

describe("trayAction", () => {
	it("offers the release download for not-installed and outdated", () => {
		expect(
			trayAction({ kind: "not-installed", health: null, version: null })?.url,
		).toBe(RELEASES_URL);
		expect(
			trayAction({ kind: "outdated", health: null, version: "0.0.1" })?.url,
		).toBe(RELEASES_URL);
	});

	it("names the version in the outdated hint when known, omits it otherwise", () => {
		const withVersion = trayAction({
			kind: "outdated",
			health: null,
			version: "0.0.1",
		});
		expect(withVersion?.hint).toContain("v0.0.1");

		const withoutVersion = trayAction({
			kind: "outdated",
			health: null,
			version: null,
		});
		expect(withoutVersion?.hint).toContain("out of date");
		expect(withoutVersion?.hint).not.toContain("(v");
	});

	it("offers no download for unreachable — a tray IS installed, restarting is the fix", () => {
		expect(
			trayAction({ kind: "unreachable", health: null, version: null })?.url,
		).toBeUndefined();
	});

	it("returns null when ready (no action needed)", () => {
		expect(
			trayAction({ kind: "ready", health: null, version: "0.1.0" }),
		).toBeNull();
	});
});

describe("renderTrayAction", () => {
	it("renders a title, hint, and CTA anchor when the action has a url", () => {
		const el = document.createElement("section");
		renderTrayAction(el, {
			title: "Install BugToPrompt",
			hint: "Install the BugToPrompt tray, then reopen this popup.",
			url: RELEASES_URL,
		});
		expect(el.hidden).toBe(false);
		expect(el.querySelector(".tray-action-title")?.textContent).toBe(
			"Install BugToPrompt",
		);
		expect(el.querySelector(".tray-action-hint")?.textContent).toBe(
			"Install the BugToPrompt tray, then reopen this popup.",
		);
		const anchor = el.querySelector("a.tray-action-cta");
		expect(anchor?.getAttribute("href")).toBe(RELEASES_URL);
		expect(anchor?.getAttribute("target")).toBe("_blank");
		expect(anchor?.getAttribute("rel")).toBe("noopener noreferrer");
	});

	it("renders no anchor when the action has no url", () => {
		const el = document.createElement("section");
		renderTrayAction(el, {
			title: "Restart the tray",
			hint: "Restart it and reopen this popup.",
		});
		expect(el.hidden).toBe(false);
		expect(el.querySelector("a")).toBeNull();
	});

	it("clears children and hides the element on a null action", () => {
		const el = document.createElement("section");
		el.append(document.createElement("span"));
		el.hidden = false;
		renderTrayAction(el, null);
		expect(el.hidden).toBe(true);
		expect(el.childNodes.length).toBe(0);
	});
});

describe("initPopup — pro button (DOM wiring)", () => {
	it("shows a retry hint and leaves no unhandled rejection when saveConfig rejects mid pro-login (P2)", async () => {
		mountPopupDom();
		const chromeApi = fakeChrome();
		// fetchProSession succeeds (so the click handler reaches saveConfig);
		// every other request (sidecar discovery/health) fails harmlessly —
		// both probeTray and discoverBaseUrl already tolerate that.
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

describe("initPopup — tray states (DOM wiring)", () => {
	it('renders "Tray not installed" with an install CTA when /health throws a plain network error', async () => {
		mountPopupDom({ trayAction: true });
		const chromeApi = fakeChrome();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("ECONNREFUSED");
			}),
		);
		try {
			await initPopup(chromeApi);
			await flushMicrotasks();
			const pillEl = document.getElementById("status-pill");
			expect(pillEl?.textContent).toBe("Tray not installed");
			const trayActionEl = document.getElementById("tray-action");
			const anchor = trayActionEl?.querySelector("a");
			expect(anchor?.getAttribute("href")).toBe(RELEASES_URL);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
