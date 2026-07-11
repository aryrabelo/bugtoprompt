import { describe, expect, it } from "vitest";
import { isValidScreenshotMode, parseBindingRows } from "./options";

describe("isValidScreenshotMode", () => {
	it("accepts the four known modes and rejects others", () => {
		expect(isValidScreenshotMode("onClick")).toBe(true);
		expect(isValidScreenshotMode("perPage")).toBe(true);
		expect(isValidScreenshotMode("onMark")).toBe(true);
		expect(isValidScreenshotMode("off")).toBe(true);
		expect(isValidScreenshotMode("nope")).toBe(false);
	});
});

describe("parseBindingRows", () => {
	it("drops fully-empty rows and keeps valid ones", () => {
		const result = parseBindingRows([
			{ host: "app.example.com", projectId: "acme/web" },
			{ host: "  ", projectId: "" },
			{ host: "*.staging.example.com", projectId: "acme/staging" },
		]);
		expect(result).toEqual({
			bindings: [
				{ host: "app.example.com", projectId: "acme/web" },
				{ host: "*.staging.example.com", projectId: "acme/staging" },
			],
		});
	});

	it("trims whitespace around fields", () => {
		expect(
			parseBindingRows([
				{ host: " app.example.com ", projectId: " acme/web " },
			]),
		).toEqual({
			bindings: [{ host: "app.example.com", projectId: "acme/web" }],
		});
	});

	it("rejects a malformed hostname", () => {
		const result = parseBindingRows([
			{ host: "https://app.example.com", projectId: "acme/web" },
		]);
		expect(result).toEqual({
			error: expect.stringMatching(/Invalid hostname/),
		});
	});

	it("rejects a malformed repo (partial row still validated)", () => {
		const result = parseBindingRows([
			{ host: "app.example.com", projectId: "acme" },
		]);
		expect(result).toEqual({
			error: expect.stringMatching(/Invalid repo/),
		});
	});
});
