// Deterministic coverage of the sidecar's self-diagnosing preflight + /health
// contract. The service's `gh` detection and health payload are extracted into
// service-preflight.mjs so they can be exercised with injected command
// lookup/exec functions — never the real `gh` binary or user account, and
// without booting the HTTP listener.
import { describe, expect, it, vi } from "vitest";
import {
	buildHealthPayload,
	detectGhState,
	detectTranscriptionState,
} from "./service-preflight.mjs";

describe("detectGhState", () => {
	it("reports 'missing' when gh is not found (no auth probe)", async () => {
		const authStatus = vi.fn();
		const state = await detectGhState({
			lookup: async () => false,
			authStatus,
		});
		expect(state).toBe("missing");
		expect(authStatus).not.toHaveBeenCalled();
	});

	it("reports 'missing' when the lookup itself throws", async () => {
		const state = await detectGhState({
			lookup: async () => {
				throw new Error("spawn gh ENOENT");
			},
			authStatus: async () => undefined,
		});
		expect(state).toBe("missing");
	});

	it("reports 'ready' when gh exists and auth status resolves", async () => {
		const state = await detectGhState({
			lookup: async () => true,
			authStatus: async () => ({ stdout: "Logged in to github.com" }),
		});
		expect(state).toBe("ready");
	});

	it("reports 'unauthenticated' when gh exists but auth status rejects", async () => {
		const state = await detectGhState({
			lookup: async () => true,
			authStatus: async () => {
				throw new Error("You are not logged into any GitHub hosts");
			},
		});
		expect(state).toBe("unauthenticated");
	});

	it("never surfaces a token — only the three coarse states", async () => {
		const state = await detectGhState({
			lookup: async () => true,
			authStatus: async () => ({ stdout: "Token: ghp_secretvalue" }),
		});
		expect(state).toBe("ready");
		expect(JSON.stringify(state)).not.toContain("ghp_");
	});
});

describe("detectTranscriptionState", () => {
	it("is 'ready' with a non-empty key", async () => {
		const state = await detectTranscriptionState({
			apiKey: "aai-key",
			detectLocal: async () => false,
		});
		expect(state).toBe("ready");
	});

	it("is 'local' when the local engine is available (LITE default)", async () => {
		const state = await detectTranscriptionState({
			apiKey: undefined,
			detectLocal: async () => true,
		});
		expect(state).toBe("local");
	});

	it("prefers 'local' over the key when both are available", async () => {
		const state = await detectTranscriptionState({
			apiKey: "aai-key",
			detectLocal: async () => true,
		});
		expect(state).toBe("local");
	});

	it("is 'unconfigured' when the key is missing/empty and local is unavailable", async () => {
		expect(
			await detectTranscriptionState({
				apiKey: undefined,
				detectLocal: async () => false,
			}),
		).toBe("unconfigured");
		expect(
			await detectTranscriptionState({
				apiKey: "",
				detectLocal: async () => false,
			}),
		).toBe("unconfigured");
	});
});

describe("buildHealthPayload", () => {
	it("assembles the exact /health contract", () => {
		expect(
			buildHealthPayload({
				issues: true,
				repos: 2,
				gh: "ready",
				transcription: "unconfigured",
			}),
		).toEqual({
			ok: true,
			issues: true,
			repos: 2,
			gh: "ready",
			transcription: "unconfigured",
		});
	});

	it("coerces issues to a strict boolean", () => {
		const payload = buildHealthPayload({
			issues: 0,
			repos: 0,
			gh: "missing",
			transcription: "unconfigured",
		});
		expect(payload.issues).toBe(false);
		expect(payload.ok).toBe(true);
	});
});
