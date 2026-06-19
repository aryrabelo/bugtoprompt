import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BugToPromptClient } from "../client";
import { clearAssemblyKey, saveAssemblyKey } from "./key-store";
import { resolveStreamingToken } from "./streaming-auth";

// ---------------------------------------------------------------------------
// Fake client
// ---------------------------------------------------------------------------

function makeFakeClient(
	overrides: Partial<BugToPromptClient> = {},
): BugToPromptClient {
	return {
		mintStreamingToken: vi
			.fn()
			.mockResolvedValue({ token: "server-token", expiresAt: 0 }),
		saveArtifact: vi.fn().mockResolvedValue({ dir: "", sessionId: "" }),
		transcribeBatch: vi.fn().mockResolvedValue({ transcript: [] }),
		createIssue: vi
			.fn()
			.mockResolvedValue({ created: true, number: 1, url: "" }),
		listTargets: vi.fn().mockResolvedValue([]),
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveStreamingToken", () => {
	beforeEach(async () => {
		delete window.__BUGTOPROMPT__;
		localStorage.clear();
		vi.restoreAllMocks();
		// Reset the module-level in-memory cache + IndexedDB CryptoKey.
		await clearAssemblyKey();
	});

	it("returns streamingToken directly when set — client.mintStreamingToken not called", async () => {
		window.__BUGTOPROMPT__ = { streamingToken: "pre-minted-token" };
		const client = makeFakeClient();

		const result = await resolveStreamingToken(client);

		expect(result).toBe("pre-minted-token");
		expect(client.mintStreamingToken).not.toHaveBeenCalled();
	});

	it("mints via assemblyAiKey: GETs the v3 token endpoint with Authorization header and returns token", async () => {
		window.__BUGTOPROMPT__ = { assemblyAiKey: "test-key" };
		const client = makeFakeClient();

		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				json: async (): Promise<{ token: string }> => ({ token: "t" }),
			}),
		);

		const result = await resolveStreamingToken(client);

		expect(result).toBe("t");
		expect(fetch).toHaveBeenCalledWith(
			"https://streaming.assemblyai.com/v3/token?expires_in_seconds=300",
			{ headers: { Authorization: "test-key" } },
		);
		expect(client.mintStreamingToken).not.toHaveBeenCalled();
	});

	it("mints via a stored key when no window hint is set — client.mintStreamingToken not called", async () => {
		await saveAssemblyKey("stored");
		// saveAssemblyKey also mirrors onto window; drop it so we exercise the
		// localStorage fallback path explicitly.
		delete window.__BUGTOPROMPT__;
		const client = makeFakeClient();

		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				json: async (): Promise<{ token: string }> => ({ token: "stored-tok" }),
			}),
		);

		const result = await resolveStreamingToken(client);

		expect(result).toBe("stored-tok");
		expect(fetch).toHaveBeenCalledWith(
			"https://streaming.assemblyai.com/v3/token?expires_in_seconds=300",
			{ headers: { Authorization: "stored" } },
		);
		expect(client.mintStreamingToken).not.toHaveBeenCalled();
	});

	it("falls through to client.mintStreamingToken when assemblyAiKey fetch rejects", async () => {
		window.__BUGTOPROMPT__ = { assemblyAiKey: "bad-key" };
		const client = makeFakeClient();

		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("CORS")));

		const result = await resolveStreamingToken(client);

		expect(result).toBe("server-token");
		expect(client.mintStreamingToken).toHaveBeenCalledOnce();
	});

	it("calls client.mintStreamingToken when neither hint is set", async () => {
		const client = makeFakeClient();

		const result = await resolveStreamingToken(client);

		expect(result).toBe("server-token");
		expect(client.mintStreamingToken).toHaveBeenCalledOnce();
	});

	it("passes targetId through to client.mintStreamingToken", async () => {
		const client = makeFakeClient();

		await resolveStreamingToken(client, "workspace-123");

		expect(client.mintStreamingToken).toHaveBeenCalledWith("workspace-123");
	});
});
