import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "./config";
import {
	buildRows,
	fetchHealth,
	type HealthPayload,
	healthPill,
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
		};
		const fetchImpl = vi.fn(async () => jsonResponse(payload));
		const health = await fetchHealth(
			"http://127.0.0.1:4127",
			fetchImpl as unknown as typeof fetch,
		);
		expect(health).toEqual(payload);
		expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:4127/health");
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
	});
});

describe("healthPill", () => {
	it("maps health state to a status tone", () => {
		expect(healthPill(null).tone).toBe("down");
		expect(
			healthPill({
				ok: true,
				issues: false,
				repos: 0,
				gh: "unauthenticated",
				transcription: "unconfigured",
			}).tone,
		).toBe("warn");
		expect(
			healthPill({
				ok: true,
				issues: true,
				repos: 1,
				gh: "ready",
				transcription: "ready",
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
		});
		const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
		expect(byKey.capture.status).toBe("On every click");
		expect(byKey.capture.ready).toBe(true);
		expect(byKey.voice.status).toBe("Ready · armed");
		expect(byKey.voice.ready).toBe(true);
		expect(byKey.issue.status).toBe("3 repo(s)");
		expect(byKey.issue.ready).toBe(true);
	});

	it("degrades gracefully when the sidecar is offline", () => {
		const rows = buildRows(DEFAULT_CONFIG, null);
		const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
		expect(byKey.voice.status).toBe("Sidecar offline");
		expect(byKey.voice.ready).toBe(false);
		expect(byKey.issue.ready).toBe(false);
	});

	it("surfaces gh states for the issue row", () => {
		const missing = buildRows(DEFAULT_CONFIG, {
			ok: true,
			issues: false,
			repos: 0,
			gh: "missing",
			transcription: "unconfigured",
		});
		expect(missing.find((r) => r.key === "issue")?.status).toBe(
			"gh CLI missing",
		);
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
