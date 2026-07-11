import type { Mock } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CaptureArtifact } from "../schema";
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

	it("createIssue POSTs prompt/artifactRef/transcriptText per server contract", async () => {
		fetchSpy.mockResolvedValue(
			okResponse({ created: true, number: 7, url: "https://gh/7" }),
		);

		const client = createFetchClient(BASE);
		await client.createIssue({
			sessionId: "sess",
			prompt: "the prompt body",
			artifactRef: "cap_sess/artifact.json",
			transcriptText: "spoken words",
			targetId: "t1",
		});

		const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("http://x/issue");
		const body = JSON.parse(init.body as string) as Record<string, unknown>;
		expect(body.sessionId).toBe("sess");
		expect(body.prompt).toBe("the prompt body");
		expect(body.artifactRef).toBe("cap_sess/artifact.json");
		expect(body.transcriptText).toBe("spoken words");
		expect(body.targetId).toBe("t1");
		// The server reads `prompt` (the issue body); the old promptRef field never existed server-side.
		expect(body.promptRef).toBeUndefined();
	});

	it("createIssue omits optional fields when not provided", async () => {
		fetchSpy.mockResolvedValue(
			okResponse({ created: true, number: 8, url: "https://gh/8" }),
		);

		await createFetchClient(BASE).createIssue({
			sessionId: "s",
			prompt: "body",
		});

		const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		const body = JSON.parse(init.body as string) as Record<string, unknown>;
		expect(body.prompt).toBe("body");
		expect(body.artifactRef).toBeUndefined();
		expect(body.transcriptText).toBeUndefined();
		expect(body.targetId).toBeUndefined();
	});

	it("throws when response is not ok", async () => {
		fetchSpy.mockResolvedValue({ ok: false, status: 500, statusText: "Error" });

		await expect(createFetchClient(BASE).listTargets("p")).rejects.toThrow(
			"500",
		);
	});
});

describe("createFetchClient.saveArtifact media upload", () => {
	const BASE = "http://x";
	const SESSION = "cap_abc";
	const artifact = { sessionId: SESSION } as unknown as CaptureArtifact;
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

	type Call = [string, RequestInit];
	const decode = (b: BodyInit | null | undefined) =>
		new TextDecoder().decode(b as Uint8Array);
	const ctype = (init: RequestInit) =>
		(init.headers as Record<string, string>)["Content-Type"];

	it("uploads screenshots + audio as binary blobs then posts slim artifact", async () => {
		const shot0 = btoa("shot-zero");
		const shot1 = btoa("shot-one");
		const audio = btoa("audio-bytes");
		fetchSpy.mockImplementation(async (url: string) => {
			if (url.includes("/blob?")) {
				const u = new URL(url);
				return okResponse({
					ref: `proj/${SESSION}/${u.searchParams.get("kind")}-${u.searchParams.get("seq")}`,
				});
			}
			return okResponse({ dir: "d", sessionId: SESSION });
		});

		const res = await createFetchClient(BASE).saveArtifact({
			artifact,
			audioBase64: audio,
			screenshotsBase64: [shot0, shot1],
		});

		const calls = fetchSpy.mock.calls as Call[];
		expect(calls).toHaveLength(4); // 2 screenshots + 1 audio + 1 artifact

		const blobCalls = calls.filter(([u]) => u.includes("/blob?"));
		expect(blobCalls).toHaveLength(3);

		const s0 = blobCalls[0];
		expect(s0[0]).toBe(`${BASE}/blob?session=${SESSION}&kind=screenshot&seq=0`);
		expect(s0[1].method).toBe("POST");
		expect(ctype(s0[1])).toBe("image/jpeg");
		expect(decode(s0[1].body)).toBe("shot-zero");

		const s1 = blobCalls[1];
		expect(s1[0]).toBe(`${BASE}/blob?session=${SESSION}&kind=screenshot&seq=1`);
		expect(ctype(s1[1])).toBe("image/jpeg");
		expect(decode(s1[1].body)).toBe("shot-one");

		const audioCall = blobCalls[2];
		expect(audioCall[0]).toBe(
			`${BASE}/blob?session=${SESSION}&kind=audio&seq=0`,
		);
		expect(ctype(audioCall[1])).toBe("audio/webm");
		expect(decode(audioCall[1].body)).toBe("audio-bytes");

		const artCall = calls.find(([u]) => u.endsWith("/artifact")) as Call;
		expect(artCall[1].method).toBe("POST");
		const body = JSON.parse(artCall[1].body as string) as Record<
			string,
			unknown
		>;
		expect(body.artifact).toEqual(artifact);
		expect(body.screenshotRefs).toEqual([
			`proj/${SESSION}/screenshot-0`,
			`proj/${SESSION}/screenshot-1`,
		]);
		expect(body.audioRef).toBe(`proj/${SESSION}/audio-0`);
		expect(body.audioBase64).toBeUndefined();
		expect(body.screenshotsBase64).toBeUndefined();
		expect(res).toEqual({ dir: "d", sessionId: SESSION });
	});

	it("falls back to legacy base64 artifact when /blob is 404 (route absent)", async () => {
		fetchSpy.mockImplementation(async (url: string) => {
			if (url.includes("/blob?"))
				return { ok: false, status: 404, statusText: "Not Found" };
			return okResponse({ dir: "d", sessionId: SESSION });
		});

		const res = await createFetchClient(BASE).saveArtifact({
			artifact,
			audioBase64: btoa("a"),
			screenshotsBase64: [btoa("s")],
		});

		const calls = fetchSpy.mock.calls as Call[];
		const artCalls = calls.filter(([u]) => u.endsWith("/artifact"));
		expect(artCalls).toHaveLength(1);
		const body = JSON.parse(artCalls[0][1].body as string) as Record<
			string,
			unknown
		>;
		expect(body.audioBase64).toBe(btoa("a"));
		expect(body.screenshotsBase64).toEqual([btoa("s")]);
		expect(body.screenshotRefs).toBeUndefined();
		expect(body.audioRef).toBeUndefined();
		expect(res).toEqual({ dir: "d", sessionId: SESSION });
	});

	it("falls back to legacy base64 artifact when /blob is 413 (too large)", async () => {
		fetchSpy.mockImplementation(async (url: string) => {
			if (url.includes("/blob?"))
				return { ok: false, status: 413, statusText: "Too Large" };
			return okResponse({ dir: "d", sessionId: SESSION });
		});

		const res = await createFetchClient(BASE).saveArtifact({
			artifact,
			audioBase64: "",
			screenshotsBase64: [btoa("s")],
		});

		const calls = fetchSpy.mock.calls as Call[];
		const artCalls = calls.filter(([u]) => u.endsWith("/artifact"));
		expect(artCalls).toHaveLength(1);
		const body = JSON.parse(artCalls[0][1].body as string) as Record<
			string,
			unknown
		>;
		expect(body.screenshotsBase64).toEqual([btoa("s")]);
		expect(res).toEqual({ dir: "d", sessionId: SESSION });
	});

	it("posts slim artifact with no media (no blob calls, no base64 fields)", async () => {
		fetchSpy.mockResolvedValue(okResponse({ dir: "d", sessionId: SESSION }));

		await createFetchClient(BASE).saveArtifact({
			artifact,
			audioBase64: "",
			screenshotsBase64: ["", ""],
		});

		expect(fetchSpy).toHaveBeenCalledOnce();
		const [url, init] = fetchSpy.mock.calls[0] as Call;
		expect(url).toBe(`${BASE}/artifact`);
		const body = JSON.parse(init.body as string) as Record<string, unknown>;
		expect(body.artifact).toEqual(artifact);
		expect(body.audioBase64).toBeUndefined();
		expect(body.screenshotsBase64).toBeUndefined();
		expect(body.screenshotRefs).toBeUndefined();
		expect(body.audioRef).toBeUndefined();
	});

	it("rejects when blob upload fails and the legacy artifact also fails", async () => {
		fetchSpy.mockImplementation(async (url: string) => {
			if (url.includes("/blob?"))
				return { ok: false, status: 413, statusText: "Too Large" };
			return {
				ok: false,
				status: 500,
				statusText: "Server Error",
				text: async () => "",
			};
		});

		await expect(
			createFetchClient(BASE).saveArtifact({
				artifact,
				audioBase64: "",
				screenshotsBase64: [btoa("s")],
			}),
		).rejects.toThrow("500");
	});
});
