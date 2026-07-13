import { describe, expect, it } from "vitest";
import {
	isOriginAllowed,
	isValidScreenshotRef,
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

describe("isValidScreenshotRef", () => {
	it("accepts bare snap-NNNN.jpg basenames", () => {
		expect(isValidScreenshotRef("snap-0000.jpg")).toBe(true);
		expect(isValidScreenshotRef("snap-0042.jpg")).toBe(true);
		// padStart(4) emits 5+ digits for long captures (index >= 10000).
		expect(isValidScreenshotRef("snap-10000.jpg")).toBe(true);
	});
	it("rejects path separators, other extensions, and junk", () => {
		for (const bad of [
			"",
			"snap-0000.png",
			"screenshots/snap-0000.jpg",
			"../snap-0000.jpg",
			"snap-12.jpg",
			"snap-00000.jpg",
			"screenshot-001.png",
			null,
			7,
		]) {
			expect(isValidScreenshotRef(bad)).toBe(false);
		}
	});
});
