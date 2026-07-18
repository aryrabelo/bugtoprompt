import { describe, expect, it, vi } from "vitest";
import {
	activateTab,
	deactivateTab,
	ensureOverlay,
	executeProOp,
	handleDocumentReady,
	init,
	isTabActive,
	toggleTab,
} from "./background";
import { type ChromeLike, DEFAULT_CONFIG } from "./config";

interface PageState {
	hasOverlay: boolean;
	ops: string[];
	/** window.__BUGTOPROMPT__ produced by the last config injection. */
	injectedGlobal?: Window["__BUGTOPROMPT__"];
}

type UpdatedListener = (
	tabId: number,
	changeInfo: { status?: string },
	tab: { url?: string },
) => void;

type MessageListener = (
	msg: unknown,
	sender: { tab?: { id?: number; url?: string } },
	sendResponse: (r?: unknown) => void,
) => boolean | undefined;

interface Harness {
	chromeApi: ChromeLike;
	pages: Map<number, PageState>;
	page(tabId: number): PageState;
	/** Origin patterns treated as already-granted by permissions.contains. */
	granted: Set<string>;
	/** tabs.onUpdated listeners registered via init(). */
	updatedListeners: UpdatedListener[];
	/** runtime.onMessage listeners registered via init(). */
	messageListeners: MessageListener[];
	/** Controls whether the next ISOLATED-world relay injection reports as
	 *  freshly initialized (result: true) — flip to false to simulate an
	 *  already-resident relay on the document (injectProRelay then skips the
	 *  MAIN-world secret seed). */
	relayState: { fresh: boolean };
}

function makeHarness(): Harness {
	const pages = new Map<number, PageState>();
	const page = (tabId: number): PageState => {
		let p = pages.get(tabId);
		if (!p) {
			p = { hasOverlay: false, ops: [] };
			pages.set(tabId, p);
		}
		return p;
	};

	const sessionStore = new Map<string, unknown>();
	const localStore = new Map<string, unknown>();
	const granted = new Set<string>();
	const updatedListeners: UpdatedListener[] = [];
	const messageListeners: MessageListener[] = [];
	const relayState = { fresh: true };

	const chromeApi: ChromeLike = {
		storage: {
			sync: {
				get: vi.fn(async () => ({})),
				set: vi.fn(async () => {}),
			},
			local: {
				get: vi.fn(async (keys: unknown) => {
					const wanted = Array.isArray(keys) ? keys : [keys];
					const result: Record<string, unknown> = {};
					for (const k of wanted) {
						const key = String(k);
						if (localStore.has(key)) result[key] = localStore.get(key);
					}
					return result;
				}),
				set: vi.fn(async (items: Record<string, unknown>) => {
					for (const [k, v] of Object.entries(items)) localStore.set(k, v);
				}),
			},
			session: {
				get: vi.fn(async (key: unknown) => {
					const k = String(key);
					return sessionStore.has(k) ? { [k]: sessionStore.get(k) } : {};
				}),
				set: vi.fn(async (items: Record<string, unknown>) => {
					for (const [k, v] of Object.entries(items)) sessionStore.set(k, v);
				}),
				remove: vi.fn(async (key: string | string[]) => {
					for (const k of Array.isArray(key) ? key : [key])
						sessionStore.delete(k);
				}),
			},
		},
		scripting: {
			executeScript: vi.fn(async (inj: Record<string, unknown>) => {
				const target = inj.target as { tabId: number };
				const p = page(target.tabId);
				const world = inj.world as string | undefined;
				const files = inj.files as string[] | undefined;
				const args = inj.args as unknown[] | undefined;
				const func = inj.func as
					| ((...fnArgs: unknown[]) => unknown)
					| undefined;
				// The ISOLATED-world relay injection (injectProRelay) carries the
				// per-injection secret as its one arg; result reflects relayState so
				// tests can simulate an already-resident relay (fresh: false) and
				// assert the MAIN-world secret seeder is skipped in that case.
				if (world === "ISOLATED") {
					p.ops.push("inject-relay");
					return [{ result: relayState.fresh }];
				}
				// The MAIN-world secret seeder (also part of injectProRelay) is
				// distinguished from the general config-seed injection below by a
				// marker in its serialized source, since both carry one string arg.
				if (func?.toString().includes("__btpProBridgeSecret")) {
					p.ops.push("inject-relay-secret");
					return [{}];
				}
				if (files?.some((f) => f.includes("bugtoprompt.global.js"))) {
					p.ops.push("inject-js");
					p.hasOverlay = true;
					return [{}];
				}
				if (!args) {
					p.ops.push("probe");
					return [{ result: p.hasOverlay }];
				}
				if (args[0] === "mount" || args[0] === "unmount") {
					p.ops.push(String(args[0]));
					return [{}];
				}
				p.ops.push("inject-config");
				// Execute the real injected function against a stub window so tests
				// can assert the exact MAIN-world config it seeds.
				if (func) {
					const stub = {} as Window & typeof globalThis;
					vi.stubGlobal("window", stub);
					try {
						func(args[0]);
						p.injectedGlobal = stub.__BUGTOPROMPT__;
					} finally {
						vi.unstubAllGlobals();
					}
				}
				return [{}];
			}),
			insertCSS: vi.fn(async (inj: Record<string, unknown>) => {
				const target = inj.target as { tabId: number };
				page(target.tabId).ops.push("inject-css");
			}),
		},
		permissions: {
			contains: vi.fn(async (opts: { origins: string[] }) =>
				opts.origins.every((o) => granted.has(o)),
			),
			request: vi.fn(async (opts: { origins: string[] }) => {
				for (const o of opts.origins) granted.add(o);
				return true;
			}),
		},
		tabs: {
			query: vi.fn(async () => []),
			onUpdated: {
				addListener: vi.fn((cb: UpdatedListener) => {
					updatedListeners.push(cb);
				}),
			},
		},
		runtime: {
			onMessage: {
				addListener: vi.fn((cb: MessageListener) => {
					messageListeners.push(cb);
				}),
			},
		},
	};

	return {
		chromeApi,
		pages,
		page,
		granted,
		updatedListeners,
		messageListeners,
		relayState,
	};
}

describe("ensureOverlay injection order & idempotency", () => {
	it("first activation probes, seeds config, injects js, then mounts (styles live in the bundle's Shadow DOM — no page CSS)", async () => {
		const h = makeHarness();
		await ensureOverlay(h.chromeApi, 1, DEFAULT_CONFIG);
		expect(h.page(1).ops).toEqual([
			"probe",
			"inject-config",
			"inject-js",
			"mount",
		]);
	});

	it("seeds MAIN-world config with manual:true and defaultOpen:true", async () => {
		const h = makeHarness();
		await ensureOverlay(h.chromeApi, 1, DEFAULT_CONFIG);
		const g = h.page(1).injectedGlobal;
		expect(g?.manual).toBe(true);
		expect(g?.defaultOpen).toBe(true);
		expect(g?.baseUrl).toBe(DEFAULT_CONFIG.baseUrl);
	});

	it("seeds pro:undefined when no PRO session token is stored", async () => {
		const h = makeHarness();
		await ensureOverlay(h.chromeApi, 1, DEFAULT_CONFIG);
		expect(h.page(1).injectedGlobal?.pro).toBeUndefined();
	});

	it("seeds pro:{baseUrl,bridged:true} when a PRO session token is stored — the raw token never reaches the MAIN world (P0, issue #82)", async () => {
		const h = makeHarness();
		await ensureOverlay(h.chromeApi, 1, {
			...DEFAULT_CONFIG,
			proToken: "sess-tok",
		});
		expect(h.page(1).injectedGlobal?.pro).toEqual({
			baseUrl: "https://api.bugtoprompt.com",
			bridged: true,
		});
		expect(JSON.stringify(h.page(1).injectedGlobal)).not.toContain("sess-tok");
	});

	it("injects an ISOLATED-world relay script carrying a fresh per-injection secret when a PRO session token is stored", async () => {
		const h = makeHarness();
		await ensureOverlay(h.chromeApi, 1, {
			...DEFAULT_CONFIG,
			proToken: "sess-tok",
		});
		expect(h.page(1).ops).toContain("inject-relay");
		const exec = vi.mocked(h.chromeApi.scripting?.executeScript);
		if (!exec) throw new Error("scripting missing");
		const relayCall = exec.mock.calls.find(([inj]) => {
			const injection = inj as Record<string, unknown>;
			return injection.world === "ISOLATED";
		});
		expect(relayCall).toBeDefined();
		const relayArgs = (relayCall?.[0] as Record<string, unknown>).args as
			| unknown[]
			| undefined;
		expect(relayArgs).toHaveLength(1);
		expect(typeof relayArgs?.[0]).toBe("string");
		expect((relayArgs?.[0] as string).length).toBeGreaterThan(0);
	});

	it("seeds the MAIN-world secret bridge with the same secret, only when the relay newly initialized", async () => {
		const h = makeHarness();
		await ensureOverlay(h.chromeApi, 1, {
			...DEFAULT_CONFIG,
			proToken: "sess-tok",
		});
		expect(h.page(1).ops).toContain("inject-relay-secret");
		const exec = vi.mocked(h.chromeApi.scripting?.executeScript);
		if (!exec) throw new Error("scripting missing");
		const relayCall = exec.mock.calls.find(
			([inj]) => (inj as Record<string, unknown>).world === "ISOLATED",
		);
		const seedCall = exec.mock.calls.find(([inj]) => {
			const func = (inj as Record<string, unknown>).func as
				| ((...a: unknown[]) => unknown)
				| undefined;
			return Boolean(func?.toString().includes("__btpProBridgeSecret"));
		});
		expect(seedCall).toBeDefined();
		expect((seedCall?.[0] as Record<string, unknown>).world).toBe("MAIN");
		const relaySecret = (relayCall?.[0] as Record<string, unknown>).args;
		const seedArgs = (seedCall?.[0] as Record<string, unknown>).args;
		expect(seedArgs).toEqual(relaySecret);
	});

	it("skips the MAIN-world secret seed when the relay is already resident on the document", async () => {
		const h = makeHarness();
		h.relayState.fresh = false;
		await ensureOverlay(h.chromeApi, 1, {
			...DEFAULT_CONFIG,
			proToken: "sess-tok",
		});
		expect(h.page(1).ops).toContain("inject-relay");
		expect(h.page(1).ops).not.toContain("inject-relay-secret");
	});

	it("does not inject a relay script when no PRO session token is stored", async () => {
		const h = makeHarness();
		await ensureOverlay(h.chromeApi, 1, DEFAULT_CONFIG);
		expect(h.page(1).ops).not.toContain("inject-relay");
	});

	it("re-seeds config (without reinjecting the bundle) when reusing an existing overlay", async () => {
		const h = makeHarness();
		h.page(2).hasOverlay = true;
		await ensureOverlay(h.chromeApi, 2, DEFAULT_CONFIG);
		expect(h.page(2).ops).toEqual(["probe", "inject-config", "mount"]);
	});
});

describe("activate / deactivate / toggle", () => {
	it("blocks protected pages before any injection", async () => {
		const h = makeHarness();
		const res = await activateTab(
			h.chromeApi,
			{ id: 3, url: "chrome://extensions" },
			DEFAULT_CONFIG,
		);
		expect(res.active).toBe(false);
		expect(res.error).toMatch(/can't run on this page/);
		expect(h.page(3).ops).toEqual([]);
		expect(await isTabActive(h.chromeApi, 3)).toBe(false);
	});

	it("rejects an http site without a granted origin permission", async () => {
		const h = makeHarness();
		const res = await activateTab(
			h.chromeApi,
			{ id: 31, url: "https://example.com/app" },
			DEFAULT_CONFIG,
		);
		expect(res.active).toBe(false);
		expect(res.error).toMatch(/Enable BugToPrompt on this site/);
		expect(h.page(31).ops).toEqual([]);
		expect(await isTabActive(h.chromeApi, 31)).toBe(false);
	});

	it("activates a granted http site and injects the mapped projectId", async () => {
		const h = makeHarness();
		h.granted.add("https://example.com/*");
		const config = {
			...DEFAULT_CONFIG,
			siteBindings: [{ host: "example.com", projectId: "acme/web" }],
		};
		const res = await activateTab(
			h.chromeApi,
			{ id: 32, url: "https://example.com/app" },
			config,
		);
		expect(res.active).toBe(true);
		expect(h.page(32).injectedGlobal?.projectId).toBe("acme/web");
		expect(h.page(32).ops).toContain("mount");
	});

	it("leaves projectId undefined on a localhost tab (zero-config)", async () => {
		const h = makeHarness();
		await activateTab(
			h.chromeApi,
			{ id: 33, url: "http://localhost:3000/" },
			DEFAULT_CONFIG,
		);
		expect(h.page(33).injectedGlobal?.projectId).toBeUndefined();
	});

	it("activates a localhost tab and records active state", async () => {
		const h = makeHarness();
		const res = await activateTab(
			h.chromeApi,
			{ id: 4, url: "http://localhost:3000/" },
			DEFAULT_CONFIG,
		);
		expect(res.active).toBe(true);
		expect(await isTabActive(h.chromeApi, 4)).toBe(true);
		expect(h.page(4).ops).toContain("mount");
	});

	it("injects the auto-discovered sidecar URL (tab port + 3)", async () => {
		const h = makeHarness();
		const fetchStub = (async (input: RequestInfo | URL) => {
			if (String(input).startsWith("http://127.0.0.1:3213/")) {
				return new Response(JSON.stringify({ ok: true }), { status: 200 });
			}
			throw new Error("connection refused");
		}) as typeof fetch;
		const res = await activateTab(
			h.chromeApi,
			{ id: 9, url: "http://localhost:3210/" },
			DEFAULT_CONFIG,
			fetchStub,
		);
		expect(res.active).toBe(true);
		expect(h.page(9).injectedGlobal?.baseUrl).toBe("http://127.0.0.1:3213");
	});

	it("deactivation unmounts and clears state", async () => {
		const h = makeHarness();
		await activateTab(
			h.chromeApi,
			{ id: 5, url: "http://127.0.0.1:5173/" },
			DEFAULT_CONFIG,
		);
		const res = await deactivateTab(h.chromeApi, 5);
		expect(res.active).toBe(false);
		expect(h.page(5).ops).toContain("unmount");
		expect(await isTabActive(h.chromeApi, 5)).toBe(false);
	});

	it("does not record the tab active when the mount injection fails", async () => {
		const h = makeHarness();
		const scripting = h.chromeApi.scripting;
		if (!scripting) throw new Error("scripting missing");
		// Fail the first MAIN-world call (the config seed) so mount never lands.
		vi.mocked(scripting.executeScript).mockRejectedValueOnce(
			new Error("injection failed"),
		);
		await expect(
			activateTab(
				h.chromeApi,
				{ id: 53, url: "http://localhost:3000/" },
				DEFAULT_CONFIG,
			),
		).rejects.toThrow();
		expect(await isTabActive(h.chromeApi, 53)).toBe(false);
	});

	it("clears session state even when unmount fails on a protected page", async () => {
		const h = makeHarness();
		await activateTab(
			h.chromeApi,
			{ id: 52, url: "http://127.0.0.1:5173/" },
			DEFAULT_CONFIG,
		);
		expect(await isTabActive(h.chromeApi, 52)).toBe(true);
		const scripting = h.chromeApi.scripting;
		if (!scripting) throw new Error("scripting missing");
		// The active tab navigated to a protected page: unmount rejects (no
		// accessible document to unmount) and deactivateTab does not swallow
		// that — but the `finally` block still clears the session flag so
		// capture actually turns off (matches the "resilience regressions"
		// contract below: the error surfaces to the toggle message handler).
		vi.mocked(scripting.executeScript).mockRejectedValueOnce(
			new Error("Cannot access a chrome:// URL"),
		);
		await expect(deactivateTab(h.chromeApi, 52)).rejects.toThrow();
		expect(await isTabActive(h.chromeApi, 52)).toBe(false);
	});

	it("toggle flips between active and inactive", async () => {
		const h = makeHarness();
		const tab = { id: 6, url: "http://localhost:8080/" };
		expect((await toggleTab(h.chromeApi, tab, DEFAULT_CONFIG)).active).toBe(
			true,
		);
		expect((await toggleTab(h.chromeApi, tab, DEFAULT_CONFIG)).active).toBe(
			false,
		);
	});
});

describe("document-ready reinjection", () => {
	it("reinjects on a fresh document only when the tab is active", async () => {
		const h = makeHarness();
		await activateTab(
			h.chromeApi,
			{ id: 7, url: "http://localhost:3000/" },
			DEFAULT_CONFIG,
		);
		// Simulate full navigation: new document has no MAIN-world singleton.
		h.page(7).hasOverlay = false;
		h.page(7).ops = [];
		await handleDocumentReady(h.chromeApi, 7, "http://localhost:3000/");
		expect(h.page(7).ops).toEqual([
			"probe",
			"inject-config",
			"inject-js",
			"mount",
		]);
	});

	it("clears active state when an active tab navigated to a protected page", async () => {
		const h = makeHarness();
		await activateTab(
			h.chromeApi,
			{ id: 71, url: "http://localhost:3000/" },
			DEFAULT_CONFIG,
		);
		h.page(71).ops = [];
		// The new document is unattachable, so MAIN-world injection must be
		// skipped (it would reject) and the session flag is cleared so the
		// tab isn't left reported active with no overlay (matches the
		// "resilience regressions" contract below for the same scenario).
		await handleDocumentReady(h.chromeApi, 71, "chrome://settings");
		expect(h.page(71).ops).toEqual([]);
		expect(await isTabActive(h.chromeApi, 71)).toBe(false);
	});

	it("does nothing for an inactive tab", async () => {
		const h = makeHarness();
		await handleDocumentReady(h.chromeApi, 8);
		expect(h.page(8).ops).toEqual([]);
	});
});

describe("init tabs.onUpdated wiring", () => {
	it("reinjects only on status===complete (localhost content script has no reach on remote pages)", () => {
		const h = makeHarness();
		init(h.chromeApi);
		expect(h.updatedListeners).toHaveLength(1);
		const listener = h.updatedListeners[0];
		const session = h.chromeApi.storage.session;
		if (!session) throw new Error("session store missing");
		const sessionGet = vi.mocked(session.get);

		// A non-complete navigation event must not reach handleDocumentReady
		// (which begins by probing the session store for the tab's active flag).
		listener(50, { status: "loading" }, { url: "https://example.com/" });
		expect(sessionGet.mock.calls.flat()).not.toContain("tab:50");

		// A completed navigation reaches handleDocumentReady, which probes the
		// session flag (and no-ops here because tab 50 is not active).
		listener(50, { status: "complete" }, { url: "https://example.com/" });
		expect(sessionGet.mock.calls.flat()).toContain("tab:50");
	});

	it("skips loopback pages so the content script owns readiness (no double-mount)", () => {
		const h = makeHarness();
		init(h.chromeApi);
		const listener = h.updatedListeners[0];
		const sessionGet = vi.mocked(h.chromeApi.storage.session?.get);
		if (!sessionGet) throw new Error("session store missing");
		listener(60, { status: "complete" }, { url: "http://localhost:3000/" });
		// Loopback never reaches handleDocumentReady, so its active-flag probe
		// (which reads tab:60) never runs.
		expect(sessionGet.mock.calls.flat()).not.toContain("tab:60");
	});
});

describe("resilience regressions", () => {
	it("clears active state even when unmount rejects on a protected page", async () => {
		const h = makeHarness();
		await activateTab(
			h.chromeApi,
			{ id: 70, url: "http://localhost:3000/" },
			DEFAULT_CONFIG,
		);
		const exec = vi.mocked(h.chromeApi.scripting?.executeScript);
		if (!exec) throw new Error("scripting missing");
		exec.mockRejectedValueOnce(new Error("no accessible document"));
		// The unmount rejects, but the finally block still clears state so the
		// tab is recoverable; the error surfaces to the toggle message handler.
		await expect(deactivateTab(h.chromeApi, 70)).rejects.toThrow();
		expect(await isTabActive(h.chromeApi, 70)).toBe(false);
	});

	it("rolls back active state when injection fails during activation", async () => {
		const h = makeHarness();
		const exec = vi.mocked(h.chromeApi.scripting?.executeScript);
		if (!exec) throw new Error("scripting missing");
		// Fail the bundle JS injection so ensureOverlay rejects mid-activation.
		exec.mockImplementation(async (inj) => {
			const files = (inj as Record<string, unknown>).files as
				| string[]
				| undefined;
			if (files?.some((f) => f.includes("bugtoprompt.global.js"))) {
				throw new Error("frame removed");
			}
			return [{ result: false }];
		});
		await expect(
			activateTab(
				h.chromeApi,
				{ id: 71, url: "http://localhost:3000/" },
				DEFAULT_CONFIG,
			),
		).rejects.toThrow();
		expect(await isTabActive(h.chromeApi, 71)).toBe(false);
	});

	it("clears active state when an active tab navigates to a non-attachable URL", async () => {
		const h = makeHarness();
		await activateTab(
			h.chromeApi,
			{ id: 72, url: "http://localhost:3000/" },
			DEFAULT_CONFIG,
		);
		h.page(72).ops = [];
		await handleDocumentReady(h.chromeApi, 72, "chrome://extensions");
		expect(await isTabActive(h.chromeApi, 72)).toBe(false);
		expect(h.page(72).ops).toEqual([]);
	});
});

describe("executeProOp (P0 token isolation, issue #82)", () => {
	it("mintStreamingToken: valid payload hits the fixed PRO endpoint with a Bearer token and returns ok:true", async () => {
		const h = makeHarness();
		await h.chromeApi.storage.local.set({ proToken: "test-token" });
		const calls: Array<{ url: string; init: RequestInit }> = [];
		const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
			calls.push({ url: String(input), init: init ?? {} });
			return new Response(JSON.stringify({ streamingToken: "abc" }), {
				status: 200,
			});
		}) as typeof fetch;
		const result = await executeProOp(
			h.chromeApi,
			"mintStreamingToken",
			{},
			fetchStub,
		);
		expect(result).toEqual({ ok: true, result: { streamingToken: "abc" } });
		const call = calls[0];
		if (!call) throw new Error("fetch was not called");
		expect(call.url).toBe("https://api.bugtoprompt.com/streaming-token");
		const headers = new Headers(call.init.headers);
		expect(headers.get("Authorization")).toBe("Bearer test-token");
		expect(call.init.method).toBe("POST");
		expect(headers.get("Content-Type")).toBe("application/json");
	});

	it("rejects an unknown op without calling fetch", async () => {
		const h = makeHarness();
		await h.chromeApi.storage.local.set({ proToken: "test-token" });
		const fetchStub = vi.fn();
		const result = await executeProOp(
			h.chromeApi,
			"deleteEverything",
			{},
			fetchStub as unknown as typeof fetch,
		);
		expect(result.ok).toBe(false);
		expect(fetchStub).not.toHaveBeenCalled();
	});

	it("rejects any op when no PRO token is stored, without calling fetch", async () => {
		const h = makeHarness();
		const fetchStub = vi.fn();
		const result = await executeProOp(
			h.chromeApi,
			"mintStreamingToken",
			{},
			fetchStub as unknown as typeof fetch,
		);
		expect(result).toEqual({ ok: false, error: "PRO is not active" });
		expect(fetchStub).not.toHaveBeenCalled();
	});

	it("createIssue: rejects a non-string sessionId as invalid payload, without calling fetch", async () => {
		const h = makeHarness();
		await h.chromeApi.storage.local.set({ proToken: "test-token" });
		const fetchStub = vi.fn();
		const result = await executeProOp(
			h.chromeApi,
			"createIssue",
			{ sessionId: 123, prompt: "fix the bug" },
			fetchStub as unknown as typeof fetch,
		);
		expect(result).toEqual({ ok: false, error: "invalid payload" });
		expect(fetchStub).not.toHaveBeenCalled();
	});
});

describe("init btp:pro-request active-tab gate (P1, issue #82 finding 1)", () => {
	function captureMessageListener(h: Harness): MessageListener {
		init(h.chromeApi);
		const listener = h.messageListeners[0];
		if (!listener) throw new Error("onMessage listener not registered");
		return listener;
	}

	it("responds unauthorized synchronously when the sender has no tab id", () => {
		const h = makeHarness();
		const listener = captureMessageListener(h);
		const sendResponse = vi.fn();
		const result = listener(
			{ type: "btp:pro-request", op: "mintStreamingToken", payload: {} },
			{},
			sendResponse,
		);
		expect(result).toBeUndefined();
		expect(sendResponse).toHaveBeenCalledWith({
			ok: false,
			error: "unauthorized",
		});
	});

	it("responds unauthorized and never calls fetch when the sender tab is not actively capturing, even with a stored PRO token", async () => {
		const h = makeHarness();
		await h.chromeApi.storage.local.set({ proToken: "test-token" });
		const listener = captureMessageListener(h);
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		try {
			const sendResponse = vi.fn();
			const result = listener(
				{ type: "btp:pro-request", op: "mintStreamingToken", payload: {} },
				{ tab: { id: 900 } },
				sendResponse,
			);
			expect(result).toBe(true);
			await vi.waitFor(() =>
				expect(sendResponse).toHaveBeenCalledWith({
					ok: false,
					error: "unauthorized",
				}),
			);
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("executes the op once the sender tab is actively capturing", async () => {
		const h = makeHarness();
		await h.chromeApi.storage.local.set({ proToken: "test-token" });
		const listener = captureMessageListener(h);
		const fetchSpy = vi.fn(
			async () =>
				new Response(JSON.stringify({ streamingToken: "abc" }), {
					status: 200,
				}),
		);
		vi.stubGlobal("fetch", fetchSpy);
		try {
			const session = h.chromeApi.storage.session;
			if (!session) throw new Error("session store missing");
			await session.set({ "tab:901": { active: true } });
			const sendResponse = vi.fn();
			const result = listener(
				{ type: "btp:pro-request", op: "mintStreamingToken", payload: {} },
				{ tab: { id: 901 } },
				sendResponse,
			);
			expect(result).toBe(true);
			await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());
			await vi.waitFor(() =>
				expect(sendResponse).toHaveBeenCalledWith({
					ok: true,
					result: { streamingToken: "abc" },
				}),
			);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

/**
 * Node's WebCrypto `subtle` operations resolve via the platform async work
 * queue, not pure microtasks, so a real macrotask tick — not just
 * `Promise.resolve()` — is required to observe "the relay's async decrypt
 * attempt settled without forwarding anything." Deterministic fake timers
 * don't help here: they'd also intercept the real timer callbacks Node's
 * WebCrypto implementation schedules internally.
 */
function tick(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, 0);
	return promise;
}

describe("injectProRelay ISOLATED relay wire behavior (contract v2.1)", () => {
	/**
	 * Captures the relay func from a fresh `ensureOverlay` injection, resets
	 * the `__btpProRelay` flag (it lives on the real `globalThis` — the relay
	 * func can't close over module scope, so it can't be scoped per-test any
	 * other way — and would otherwise make every `it` after the first see
	 * the flag already set and skip listener registration), then invokes it
	 * under stubbed `window`/`chrome` globals. Returns the captured listener
	 * plus AAD-aware encrypt/decrypt helpers mirroring the relay's own
	 * (`btp:req:`/`btp:res:` + wire id).
	 */
	async function setupRelay() {
		const h = makeHarness();
		await ensureOverlay(h.chromeApi, 1, {
			...DEFAULT_CONFIG,
			proToken: "sess-tok",
		});
		const exec = vi.mocked(h.chromeApi.scripting?.executeScript);
		if (!exec) throw new Error("scripting missing");
		const relayCall = exec.mock.calls.find(
			([inj]) => (inj as Record<string, unknown>).world === "ISOLATED",
		);
		if (!relayCall) throw new Error("relay call not captured");
		const relayInj = relayCall[0] as Record<string, unknown>;
		const relayFunc = relayInj.func as (secret: string) => boolean;
		const relayArgs = relayInj.args as unknown[];
		const secret = relayArgs[0] as string;

		const listeners: Array<(ev: MessageEvent) => void> = [];
		const posted: Array<Record<string, unknown>> = [];
		const stubWindow = {
			addEventListener: (_type: string, cb: (ev: MessageEvent) => void) => {
				listeners.push(cb);
			},
			postMessage: (msg: Record<string, unknown>) => {
				posted.push(msg);
			},
		};
		const sendMessage = vi.fn(async () => ({
			ok: true,
			result: { streamingToken: "abc" },
		}));
		vi.stubGlobal("window", stubWindow);
		vi.stubGlobal("chrome", { runtime: { sendMessage } });
		const flagged = globalThis as unknown as { __btpProRelay?: boolean };
		delete flagged.__btpProRelay;

		expect(relayFunc(secret)).toBe(true);
		const listener = listeners[0];
		if (!listener) throw new Error("relay did not register a listener");

		const rawKey = await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(secret),
		);
		const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, [
			"encrypt",
			"decrypt",
		]);
		const toB64 = (bytes: Uint8Array): string => {
			let binary = "";
			for (let i = 0; i < bytes.length; i++) {
				binary += String.fromCharCode(bytes[i]);
			}
			return btoa(binary);
		};
		const fromB64 = (b64: string): Uint8Array<ArrayBuffer> => {
			const binary = atob(b64);
			const bytes = new Uint8Array(binary.length);
			for (let i = 0; i < binary.length; i++) {
				bytes[i] = binary.charCodeAt(i);
			}
			return bytes;
		};
		const encryptWithAad = async (
			obj: unknown,
			aad: string,
		): Promise<{ iv: string; data: string }> => {
			const iv = crypto.getRandomValues(new Uint8Array(12));
			const cipher = await crypto.subtle.encrypt(
				{ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) },
				key,
				new TextEncoder().encode(JSON.stringify(obj)),
			);
			return { iv: toB64(iv), data: toB64(new Uint8Array(cipher)) };
		};
		const decryptWithAad = async (
			enc: { iv: string; data: string },
			aad: string,
		): Promise<unknown> => {
			const plain = await crypto.subtle.decrypt(
				{
					name: "AES-GCM",
					iv: fromB64(enc.iv),
					additionalData: new TextEncoder().encode(aad),
				},
				key,
				fromB64(enc.data),
			);
			return JSON.parse(new TextDecoder().decode(plain));
		};

		return {
			stubWindow,
			listener,
			posted,
			sendMessage,
			encryptWithAad,
			decryptWithAad,
		};
	}

	it("round-trips an AAD-bound encrypted request/response and drops a plaintext request while crypto.subtle is available", async () => {
		const {
			stubWindow,
			listener,
			posted,
			sendMessage,
			encryptWithAad,
			decryptWithAad,
		} = await setupRelay();
		try {
			const enc = await encryptWithAad(
				{ op: "mintStreamingToken", payload: {} },
				"btp:req:req-1",
			);

			listener({
				source: stubWindow,
				data: { type: "btp:pro-request", id: "req-1", enc },
			} as unknown as MessageEvent);
			await vi.waitFor(() => expect(posted).toHaveLength(1));

			expect(sendMessage).toHaveBeenCalledWith({
				type: "btp:pro-request",
				op: "mintStreamingToken",
				payload: {},
			});
			const respMsg = posted[0];
			expect(respMsg?.type).toBe("btp:pro-response");
			expect(respMsg?.id).toBe("req-1");
			const respEnc = respMsg?.enc as { iv: string; data: string };
			const decrypted = await decryptWithAad(respEnc, "btp:res:req-1");
			expect(decrypted).toEqual({
				ok: true,
				result: { streamingToken: "abc" },
			});

			sendMessage.mockClear();
			posted.length = 0;
			listener({
				source: stubWindow,
				data: {
					type: "btp:pro-request",
					id: "req-2",
					op: "mintStreamingToken",
					payload: {},
				},
			} as unknown as MessageEvent);
			await tick();
			expect(sendMessage).not.toHaveBeenCalled();
			expect(posted).toHaveLength(0);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("drops a replayed encrypted request (same id posted twice) — forwards exactly once", async () => {
		const { stubWindow, listener, posted, sendMessage, encryptWithAad } =
			await setupRelay();
		try {
			const enc = await encryptWithAad(
				{ op: "mintStreamingToken", payload: {} },
				"btp:req:req-replay",
			);
			const msg = {
				source: stubWindow,
				data: { type: "btp:pro-request", id: "req-replay", enc },
			} as unknown as MessageEvent;

			listener(msg);
			await vi.waitFor(() => expect(posted).toHaveLength(1));
			expect(sendMessage).toHaveBeenCalledTimes(1);

			listener(msg); // replay: identical envelope under the same wire id
			await tick();
			expect(sendMessage).toHaveBeenCalledTimes(1);
			expect(posted).toHaveLength(1);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("drops a request envelope rebound to a different wire id, but a correctly-bound envelope still round-trips its AAD", async () => {
		const {
			stubWindow,
			listener,
			posted,
			sendMessage,
			encryptWithAad,
			decryptWithAad,
		} = await setupRelay();
		try {
			// Encrypted for id "req-a"'s AAD, but posted under wire id "req-b" —
			// GCM auth fails, so it must never reach sendMessage.
			const encForA = await encryptWithAad(
				{ op: "mintStreamingToken", payload: {} },
				"btp:req:req-a",
			);
			listener({
				source: stubWindow,
				data: { type: "btp:pro-request", id: "req-b", enc: encForA },
			} as unknown as MessageEvent);
			await tick();
			expect(sendMessage).not.toHaveBeenCalled();
			expect(posted).toHaveLength(0);

			// Correctly-bound envelope still round-trips; response decrypts only
			// under "btp:res:" + the same id.
			const enc = await encryptWithAad(
				{ op: "mintStreamingToken", payload: {} },
				"btp:req:req-c",
			);
			listener({
				source: stubWindow,
				data: { type: "btp:pro-request", id: "req-c", enc },
			} as unknown as MessageEvent);
			await vi.waitFor(() => expect(posted).toHaveLength(1));
			expect(sendMessage).toHaveBeenCalledTimes(1);
			const respMsg = posted[0];
			expect(respMsg?.id).toBe("req-c");
			const respEnc = respMsg?.enc as { iv: string; data: string };
			const decrypted = await decryptWithAad(respEnc, "btp:res:req-c");
			expect(decrypted).toEqual({
				ok: true,
				result: { streamingToken: "abc" },
			});
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("releases the replay claim after an undecryptable envelope, so a genuine request under the same id later forwards", async () => {
		const { stubWindow, listener, posted, sendMessage, encryptWithAad } =
			await setupRelay();
		try {
			// Undecryptable: valid ciphertext but bound to the wrong AAD, so it
			// fails GCM auth under the id it's actually posted with.
			const garbage = await encryptWithAad(
				{ op: "mintStreamingToken", payload: {} },
				"btp:req:not-req-x",
			);
			listener({
				source: stubWindow,
				data: { type: "btp:pro-request", id: "req-x", enc: garbage },
			} as unknown as MessageEvent);
			await tick();
			expect(sendMessage).not.toHaveBeenCalled();
			expect(posted).toHaveLength(0);

			// A genuine envelope under the SAME wire id proves the failed
			// attempt released its tentative claim rather than poisoning it.
			const enc = await encryptWithAad(
				{ op: "mintStreamingToken", payload: {} },
				"btp:req:req-x",
			);
			listener({
				source: stubWindow,
				data: { type: "btp:pro-request", id: "req-x", enc },
			} as unknown as MessageEvent);
			await vi.waitFor(() => expect(posted).toHaveLength(1));
			expect(sendMessage).toHaveBeenCalledTimes(1);
			expect(posted[0]?.id).toBe("req-x");
		} finally {
			vi.unstubAllGlobals();
		}
	});
	it("round-3 P0 regression: a >10k flood of secret-less garbage cannot evict a processed id — replaying the captured genuine ciphertext never forwards twice", async () => {
		const { stubWindow, listener, posted, sendMessage, encryptWithAad } =
			await setupRelay();
		try {
			// 1. One genuine op forwards (and its id becomes processed).
			const enc = await encryptWithAad(
				{ op: "createIssue", payload: { sessionId: "s1", prompt: "p" } },
				"btp:req:req-victim",
			);
			const genuine = {
				source: stubWindow,
				data: { type: "btp:pro-request", id: "req-victim", enc },
			} as unknown as MessageEvent;
			listener(genuine);
			await vi.waitFor(() => expect(posted).toHaveLength(1));
			expect(sendMessage).toHaveBeenCalledTimes(1);

			// 2. The exploit: flood more than the FIFO cap with cheap
			// envelopes an attacker can mint WITHOUT the secret (they never
			// decrypt). Under the round-2 guard these advanced the eviction
			// queue at claim time and pushed req-victim out of the replay
			// window; now only successful decrypts can advance it.
			const garbage = { iv: "AAAAAAAAAAAAAAAA", data: "Z2FyYmFnZQ==" };
			for (let i = 0; i < 10_001; i++) {
				listener({
					source: stubWindow,
					data: { type: "btp:pro-request", id: `flood-${i}`, enc: garbage },
				} as unknown as MessageEvent);
			}
			await tick();

			// 3. Replay the passively-captured genuine ciphertext.
			listener(genuine);
			await tick();
			expect(sendMessage).toHaveBeenCalledTimes(1); // exactly once, ever
			expect(posted).toHaveLength(1);

			// 4. The in-flight flood guard is transient: once the garbage
			// decrypt failures settle, a fresh genuine op still forwards.
			const encAfter = await encryptWithAad(
				{ op: "mintStreamingToken", payload: {} },
				"btp:req:req-after",
			);
			await vi.waitFor(() => {
				// Re-posting on retry is safe: a drop from a full in-flight
				// set records nothing, and a success makes later posts
				// replay-drops without a second forward.
				listener({
					source: stubWindow,
					data: { type: "btp:pro-request", id: "req-after", enc: encAfter },
				} as unknown as MessageEvent);
				expect(sendMessage).toHaveBeenCalledTimes(2);
			});
			expect(sendMessage).toHaveBeenLastCalledWith({
				type: "btp:pro-request",
				op: "mintStreamingToken",
				payload: {},
			});
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
