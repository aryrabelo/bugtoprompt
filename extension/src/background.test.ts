import { describe, expect, it, vi } from "vitest";
import {
	activateTab,
	deactivateTab,
	ensureOverlay,
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

interface Harness {
	chromeApi: ChromeLike;
	pages: Map<number, PageState>;
	page(tabId: number): PageState;
	/** Origin patterns treated as already-granted by permissions.contains. */
	granted: Set<string>;
	/** tabs.onUpdated listeners registered via init(). */
	updatedListeners: UpdatedListener[];
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
	const granted = new Set<string>();
	const updatedListeners: UpdatedListener[] = [];

	const chromeApi: ChromeLike = {
		storage: {
			sync: {
				get: vi.fn(async () => ({})),
				set: vi.fn(async () => {}),
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
				const files = inj.files as string[] | undefined;
				const args = inj.args as unknown[] | undefined;
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
				const func = inj.func as ((cfg: unknown) => void) | undefined;
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
	};

	return { chromeApi, pages, page, granted, updatedListeners };
}

describe("ensureOverlay injection order & idempotency", () => {
	it("first activation injects config then js, then mounts (styles live in the bundle's Shadow DOM — no page CSS)", async () => {
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

	it("reuses an existing overlay without reinjecting", async () => {
		const h = makeHarness();
		h.page(2).hasOverlay = true;
		await ensureOverlay(h.chromeApi, 2, DEFAULT_CONFIG);
		expect(h.page(2).ops).toEqual(["probe", "mount"]);
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
		await handleDocumentReady(h.chromeApi, 7);
		expect(h.page(7).ops).toEqual([
			"probe",
			"inject-config",
			"inject-js",
			"mount",
		]);
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
});
