import { describe, expect, it } from "vitest";
import {
	isOriginAllowed,
	isValidSessionId,
	parseAllowedOrigins,
} from "./service-security.mjs";

describe("isValidSessionId", () => {
	it("accepts cap_ ids", () => {
		expect(isValidSessionId("cap_abc-123")).toBe(true);
	});
	it("rejects traversal and junk", () => {
		for (const bad of [
			"",
			"../../etc/passwd",
			"/abs",
			"cap_../x",
			"x",
			null,
			42,
		]) {
			expect(isValidSessionId(bad)).toBe(false);
		}
	});
});

describe("isOriginAllowed", () => {
	const allow = parseAllowedOrigins({
		BUGTOPROMPT_ALLOWED_ORIGINS: "https://app.example.com",
	});
	it("allows localhost, tauri, configured, and no-origin", () => {
		expect(isOriginAllowed("http://localhost:5173", allow)).toBe(true);
		expect(isOriginAllowed("http://127.0.0.1:3000", allow)).toBe(true);
		expect(isOriginAllowed("tauri://localhost", allow)).toBe(true);
		expect(isOriginAllowed("https://app.example.com", allow)).toBe(true);
		expect(isOriginAllowed(undefined, allow)).toBe(true);
	});
	it("denies arbitrary cross-site origins", () => {
		expect(isOriginAllowed("https://evil.com", allow)).toBe(false);
	});
});
