import { describe, expect, it, vi } from "vitest";
import {
	type ChromeLike,
	candidateBaseUrls,
	classifyPage,
	DEFAULT_CONFIG,
	discoverBaseUrl,
	isLoopbackHttpUrl,
	isOutputMode,
	isSupportedUrl,
	isValidBindingHost,
	isValidProjectId,
	loadConfig,
	normalizeBindings,
	originPattern,
	resolveProjectId,
	type SyncConfig,
	saveConfig,
} from "./config";

describe("isSupportedUrl", () => {
	it("accepts plain http loopback pages", () => {
		expect(isSupportedUrl("http://localhost:3000/app")).toBe(true);
		expect(isSupportedUrl("http://127.0.0.1:5173/")).toBe(true);
	});

	it("rejects https, remote hosts, IPv6 loopback, and protected pages", () => {
		expect(isSupportedUrl("https://localhost:3000/")).toBe(false);
		expect(isSupportedUrl("http://example.com/")).toBe(false);
		expect(isSupportedUrl("http://[::1]:3000/")).toBe(false);
		expect(isSupportedUrl("chrome://extensions")).toBe(false);
		expect(isSupportedUrl("about:blank")).toBe(false);
	});

	it("rejects embedded credentials and junk", () => {
		expect(isSupportedUrl("http://user:pass@localhost:3000/")).toBe(false);
		expect(isSupportedUrl(undefined)).toBe(false);
		expect(isSupportedUrl("not a url")).toBe(false);
	});
});

describe("isLoopbackHttpUrl (options validation)", () => {
	it("accepts a clean loopback origin", () => {
		expect(isLoopbackHttpUrl("http://127.0.0.1:4127")).toBe(true);
		expect(isLoopbackHttpUrl("http://localhost:4127/")).toBe(true);
	});

	it("rejects remote origins, https, credentials, and non-root paths", () => {
		expect(isLoopbackHttpUrl("https://127.0.0.1:4127")).toBe(false);
		expect(isLoopbackHttpUrl("http://evil.com:4127")).toBe(false);
		expect(isLoopbackHttpUrl("http://user:pw@localhost:4127")).toBe(false);
		expect(isLoopbackHttpUrl("http://127.0.0.1:4127/path")).toBe(false);
		expect(isLoopbackHttpUrl("http://127.0.0.1:4127/?x=1")).toBe(false);
	});
});

function fakeChrome(store: Record<string, unknown> = {}): ChromeLike {
	return {
		storage: {
			sync: {
				get: vi.fn(async () => ({ ...store })),
				set: vi.fn(async (items: Record<string, unknown>) => {
					Object.assign(store, items);
				}),
			},
		},
	};
}

describe("loadConfig / saveConfig", () => {
	it("returns defaults when storage is empty", async () => {
		const cfg = await loadConfig(fakeChrome());
		expect(cfg).toEqual(DEFAULT_CONFIG);
	});

	it("keeps valid stored values and falls back on invalid ones", async () => {
		const cfg = await loadConfig(
			fakeChrome({ baseUrl: "https://evil.com", screenshotMode: "onMark" }),
		);
		expect(cfg.baseUrl).toBe(DEFAULT_CONFIG.baseUrl); // invalid → default
		expect(cfg.screenshotMode).toBe("onMark");
	});

	it("drops invalid modes entries, keeping defaults when none survive", async () => {
		const partial = await loadConfig(
			fakeChrome({ modes: ["issue", "bogus", 3] }),
		);
		expect(partial.modes).toEqual(["issue"]);
		const allBad = await loadConfig(fakeChrome({ modes: ["nope", 1] }));
		expect(allBad.modes).toEqual(DEFAULT_CONFIG.modes);
	});

	it("saves a valid baseUrl and rejects a remote one", async () => {
		const chromeApi = fakeChrome();
		const merged = await saveConfig(chromeApi, {
			baseUrl: "http://localhost:9000",
		});
		expect(merged.baseUrl).toBe("http://localhost:9000");
		await expect(
			saveConfig(chromeApi, { baseUrl: "http://evil.com" }),
		).rejects.toThrow(/loopback/);
	});

	it("rejects empty or invalid modes at save time", async () => {
		const chromeApi = fakeChrome();
		await expect(saveConfig(chromeApi, { modes: [] })).rejects.toThrow(/modes/);
		await expect(
			saveConfig(chromeApi, {
				modes: ["issue", "bogus"] as unknown as SyncConfig["modes"],
			}),
		).rejects.toThrow(/modes/);
	});

	it("canonicalizes a trailing-slash baseUrl to its origin before storing", async () => {
		const chromeApi = fakeChrome();
		const merged = await saveConfig(chromeApi, {
			baseUrl: "http://127.0.0.1:4127/",
		});
		expect(merged.baseUrl).toBe("http://127.0.0.1:4127");
		const reloaded = await loadConfig(chromeApi);
		expect(reloaded.baseUrl).toBe("http://127.0.0.1:4127");
	});

	it("proToken defaults to empty, persists through saveConfig, and coerces non-string garbage to empty", async () => {
		const chromeApi = fakeChrome();
		expect((await loadConfig(chromeApi)).proToken).toBe("");
		const merged = await saveConfig(chromeApi, { proToken: "sess-tok" });
		expect(merged.proToken).toBe("sess-tok");
		const reloaded = await loadConfig(chromeApi);
		expect(reloaded.proToken).toBe("sess-tok");

		const garbage = await loadConfig(fakeChrome({ proToken: 42 }));
		expect(garbage.proToken).toBe("");
	});
});

describe("candidateBaseUrls (sidecar auto-discovery order)", () => {
	it("orders configured URL, tab port + 3, then the portless default", () => {
		expect(
			candidateBaseUrls("http://127.0.0.1:4127", "http://localhost:3210/app"),
		).toEqual([
			"http://127.0.0.1:4127",
			"http://127.0.0.1:3213",
			// default equals the configured entry, so it deduplicates away
		]);
	});

	it("deduplicates and ignores unsupported tab URLs", () => {
		expect(
			candidateBaseUrls("http://127.0.0.1:4127", "https://example.com"),
		).toEqual(["http://127.0.0.1:4127"]);
		expect(candidateBaseUrls("http://127.0.0.1:9999", undefined)).toEqual([
			"http://127.0.0.1:9999",
			"http://127.0.0.1:4127",
		]);
	});

	it("normalizes a trailing-slash configured URL to its origin", () => {
		expect(candidateBaseUrls("http://localhost:4127/", undefined)).toEqual([
			"http://localhost:4127",
			"http://127.0.0.1:4127",
		]);
	});
});

describe("discoverBaseUrl", () => {
	const healthy = (url: string): typeof fetch =>
		(async (input: RequestInfo | URL) => {
			const target = String(input);
			if (target.startsWith(url)) {
				return new Response(JSON.stringify({ ok: true }), { status: 200 });
			}
			throw new Error("connection refused");
		}) as typeof fetch;

	it("returns the first healthy candidate", async () => {
		const res = await discoverBaseUrl(
			["http://127.0.0.1:4127", "http://127.0.0.1:3213"],
			healthy("http://127.0.0.1:3213"),
		);
		expect(res).toEqual({ baseUrl: "http://127.0.0.1:3213", healthy: true });
	});

	it("falls back to the first candidate when none answer", async () => {
		const res = await discoverBaseUrl(
			["http://127.0.0.1:4127", "http://127.0.0.1:3213"],
			healthy("http://nowhere"),
		);
		expect(res).toEqual({ baseUrl: "http://127.0.0.1:4127", healthy: false });
	});
});

describe("classifyPage", () => {
	it("classifies loopback, http, protected, and invalid pages", () => {
		expect(classifyPage("http://localhost:3000/app")).toBe("loopback");
		expect(classifyPage("http://127.0.0.1:5173/")).toBe("loopback");
		expect(classifyPage("https://example.com/x")).toBe("http");
		expect(classifyPage("http://example.com/")).toBe("http");
		expect(classifyPage("chrome://extensions")).toBe("protected");
		expect(classifyPage("file:///Users/me/x.html")).toBe("protected");
		expect(classifyPage("https://chromewebstore.google.com/detail/x")).toBe(
			"protected",
		);
		expect(classifyPage("http://user:pw@example.com/")).toBe("invalid");
		expect(classifyPage("not a url")).toBe("invalid");
		expect(classifyPage(undefined)).toBe("invalid");
	});
});

describe("originPattern", () => {
	it("builds an origin/* pattern and rejects junk", () => {
		expect(originPattern("https://example.com/a/b?q=1")).toBe(
			"https://example.com/*",
		);
		expect(originPattern("http://localhost:3000/x")).toBe(
			"http://localhost:3000/*",
		);
		expect(originPattern("not a url")).toBeNull();
		expect(originPattern(undefined)).toBeNull();
	});
});

describe("binding validation", () => {
	it("accepts exact hosts and *.suffix wildcards, rejects schemes/paths", () => {
		expect(isValidBindingHost("app.example.com")).toBe(true);
		expect(isValidBindingHost("*.example.com")).toBe(true);
		expect(isValidBindingHost("localhost")).toBe(true);
		expect(isValidBindingHost("https://app.example.com")).toBe(false);
		expect(isValidBindingHost("app.example.com/path")).toBe(false);
		expect(isValidBindingHost("app example.com")).toBe(false);
		expect(isValidBindingHost("")).toBe(false);
		expect(isValidBindingHost("*.")).toBe(false);
	});

	it("accepts owner/repo slugs only", () => {
		expect(isValidProjectId("acme/web-app")).toBe(true);
		expect(isValidProjectId("a.b/c.d")).toBe(true);
		expect(isValidProjectId("acme")).toBe(false);
		expect(isValidProjectId("acme/web/app")).toBe(false);
		expect(isValidProjectId("acme/")).toBe(false);
	});
});

describe("resolveProjectId (exact beats wildcard, longest suffix wins)", () => {
	const bindings = [
		{ host: "*.example.com", projectId: "acme/wild" },
		{ host: "app.example.com", projectId: "acme/app" },
		{ host: "*.staging.example.com", projectId: "acme/staging" },
	];

	it("prefers an exact host match over any wildcard", () => {
		expect(resolveProjectId(bindings, "app.example.com")).toBe("acme/app");
	});

	it("falls back to the longest matching wildcard suffix", () => {
		expect(resolveProjectId(bindings, "api.staging.example.com")).toBe(
			"acme/staging",
		);
		expect(resolveProjectId(bindings, "cdn.example.com")).toBe("acme/wild");
	});

	it("returns undefined when nothing matches", () => {
		expect(resolveProjectId(bindings, "other.org")).toBeUndefined();
		expect(resolveProjectId(bindings, undefined)).toBeUndefined();
		expect(resolveProjectId([], "app.example.com")).toBeUndefined();
	});
});

describe("siteBindings persistence", () => {
	it("normalizes stored bindings, dropping invalid entries", () => {
		expect(
			normalizeBindings([
				{ host: "app.example.com", projectId: "acme/app" },
				{ host: "bad host", projectId: "acme/x" },
				{ host: "y.com", projectId: "not-a-repo" },
				"junk",
			]),
		).toEqual([{ host: "app.example.com", projectId: "acme/app" }]);
		expect(normalizeBindings(undefined)).toEqual([]);
	});

	it("load returns stored bindings; save rejects malformed ones", async () => {
		const cfg = await loadConfig(
			fakeChrome({
				siteBindings: [{ host: "*.example.com", projectId: "acme/w" }],
			}),
		);
		expect(cfg.siteBindings).toEqual([
			{ host: "*.example.com", projectId: "acme/w" },
		]);

		const chromeApi = fakeChrome();
		const merged = await saveConfig(chromeApi, {
			siteBindings: [{ host: "app.example.com", projectId: "acme/app" }],
		});
		expect(merged.siteBindings).toEqual([
			{ host: "app.example.com", projectId: "acme/app" },
		]);
		await expect(
			saveConfig(chromeApi, {
				siteBindings: [{ host: "bad host", projectId: "acme/x" }],
			}),
		).rejects.toThrow(/Invalid site binding/);
	});

	it("normalizes whitespace and dedupes bindings on save", async () => {
		const chromeApi = fakeChrome();
		const merged = await saveConfig(chromeApi, {
			siteBindings: [
				{ host: "  app.example.com  ", projectId: " acme/app " },
				{ host: "app.example.com", projectId: "acme/other" },
			],
		});
		expect(merged.siteBindings).toEqual([
			{ host: "app.example.com", projectId: "acme/other" },
		]);
	});
});

describe("isOutputMode + mode validation", () => {
	it("guards documented modes only", () => {
		expect(isOutputMode("issue")).toBe(true);
		expect(isOutputMode("download")).toBe(true);
		expect(isOutputMode("bogus")).toBe(false);
		expect(isOutputMode(42)).toBe(false);
	});

	it("loadConfig drops invalid mode elements and falls back when none valid", async () => {
		const cfg = await loadConfig(fakeChrome({ modes: ["issue", "bogus", 7] }));
		expect(cfg.modes).toEqual(["issue"]);
		const cfg2 = await loadConfig(fakeChrome({ modes: ["bogus"] }));
		expect(cfg2.modes).toEqual(DEFAULT_CONFIG.modes);
	});

	it("saveConfig rejects empty or invalid modes", async () => {
		const chromeApi = fakeChrome();
		await expect(saveConfig(chromeApi, { modes: [] })).rejects.toThrow(/modes/);
		await expect(
			saveConfig(chromeApi, { modes: ["bogus"] as never }),
		).rejects.toThrow(/modes/);
	});

	it("saveConfig re-pins an orphaned defaultMode to the first retained mode", async () => {
		const chromeApi = fakeChrome({ defaultMode: "issue" });
		const merged = await saveConfig(chromeApi, { modes: ["clipboard"] });
		expect(merged.modes).toEqual(["clipboard"]);
		expect(merged.defaultMode).toBe("clipboard");
	});

	it("loadConfig re-pins a stored defaultMode absent from modes", async () => {
		const cfg = await loadConfig(
			fakeChrome({ modes: ["clipboard", "download"], defaultMode: "issue" }),
		);
		expect(cfg.defaultMode).toBe("clipboard");
	});
});

describe("candidateBaseUrls trailing-slash canonicalization", () => {
	it("normalizes a configured URL with a trailing slash to its origin", () => {
		expect(candidateBaseUrls("http://127.0.0.1:4127/", undefined)).toEqual([
			"http://127.0.0.1:4127",
		]);
	});
});
