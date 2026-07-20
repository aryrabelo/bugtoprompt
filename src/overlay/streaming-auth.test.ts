import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BugToPromptClient } from "../client";
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
	beforeEach(() => {
		delete window.__BUGTOPROMPT__;
		localStorage.clear();
		vi.restoreAllMocks();
	});

	it("returns streamingToken directly when set — client.mintStreamingToken not called", async () => {
		window.__BUGTOPROMPT__ = { streamingToken: "pre-minted-token" };
		const client = makeFakeClient();

		const result = await resolveStreamingToken(client);

		expect(result).toBe("pre-minted-token");
		expect(client.mintStreamingToken).not.toHaveBeenCalled();
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
