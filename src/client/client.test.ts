import type { Mock } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFetchClient } from "./index";

describe("createFetchClient", () => {
	const BASE = "http://x";
	let fetchSpy: Mock;

	beforeEach(() => {
		fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	function okResponse(body: unknown) {
		return { ok: true, json: async () => body };
	}

	it("listTargets calls GET /targets?projectId=<id>", async () => {
		const targets = [{ id: "t1", name: "main", branch: "main" }];
		fetchSpy.mockResolvedValue(okResponse(targets));

		const client = createFetchClient(BASE);
		const result = await client.listTargets("p1");

		expect(fetchSpy).toHaveBeenCalledOnce();
		const [url] = fetchSpy.mock.calls[0] as [string, ...unknown[]];
		expect(url).toBe("http://x/targets?projectId=p1");
		expect(result).toEqual(targets);
	});

	it("mintStreamingToken POSTs JSON body with targetId", async () => {
		fetchSpy.mockResolvedValue(okResponse({ token: "tok", expiresAt: 999 }));

		const client = createFetchClient(BASE);
		const result = await client.mintStreamingToken("w1");

		expect(fetchSpy).toHaveBeenCalledOnce();
		const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("http://x/streaming-token");
		expect(init.method).toBe("POST");
		expect(JSON.parse(init.body as string)).toEqual({ targetId: "w1" });
		expect(result).toEqual({ token: "tok", expiresAt: 999 });
	});

	it("mintStreamingToken omits targetId when undefined", async () => {
		fetchSpy.mockResolvedValue(okResponse({ token: "t", expiresAt: 0 }));

		await createFetchClient(BASE).mintStreamingToken();

		const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		expect(JSON.parse(init.body as string)).toEqual({});
	});

	it("createIssue POSTs correct fields including prompt", async () => {
		fetchSpy.mockResolvedValue(
			okResponse({ created: true, number: 7, url: "https://gh/7" }),
		);

		const client = createFetchClient(BASE);
		await client.createIssue({
			projectId: "proj",
			sessionId: "sess",
			prompt: "the prompt body",
			targetId: "t1",
		});

		const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("http://x/issue");
		const body = JSON.parse(init.body as string) as Record<string, unknown>;
		expect(body.projectId).toBe("proj");
		expect(body.sessionId).toBe("sess");
		expect(body.prompt).toBe("the prompt body");
		expect(body.targetId).toBe("t1");
	});

	it("createIssue omits targetId when not provided", async () => {
		fetchSpy.mockResolvedValue(
			okResponse({ created: true, number: 8, url: "https://gh/8" }),
		);

		await createFetchClient(BASE).createIssue({
			projectId: "p",
			sessionId: "s",
			prompt: "body",
		});

		const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		const body = JSON.parse(init.body as string) as Record<string, unknown>;
		expect(body.targetId).toBeUndefined();
	});

	it("throws when response is not ok", async () => {
		fetchSpy.mockResolvedValue({ ok: false, status: 500, statusText: "Error" });

		await expect(createFetchClient(BASE).listTargets("p")).rejects.toThrow(
			"500",
		);
	});
});
