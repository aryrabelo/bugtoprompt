import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findWithResolversUsages } from "./check-node-compat.mjs";

let tmpDirs = [];

function makeTmpSrc() {
	const dir = mkdtempSync(join(tmpdir(), "check-node-compat-"));
	tmpDirs.push(dir);
	const src = join(dir, "src");
	mkdirSync(src, { recursive: true });
	return { root: dir, src };
}

afterEach(() => {
	for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
	tmpDirs = [];
});

describe("findWithResolversUsages", () => {
	it("flags a real Promise.withResolvers() call", () => {
		const { root, src } = makeTmpSrc();
		writeFileSync(
			join(src, "bad.ts"),
			"const { promise, resolve } = Promise.withResolvers();\n",
		);

		expect(findWithResolversUsages(src, root)).toEqual(["src/bad.ts:1"]);
	});

	it("ignores mentions inside comments (e.g. the Node-18 shim's doc comment)", () => {
		const { root, src } = makeTmpSrc();
		const shimDir = join(src, "overlay", "util");
		mkdirSync(shimDir, { recursive: true });
		writeFileSync(
			join(shimDir, "deferred.ts"),
			[
				"/**",
				" * Node-18-compatible alternative to `Promise.withResolvers()` (ES2024).",
				" */",
				"export function deferred() {}",
				"",
			].join("\n"),
		);

		expect(findWithResolversUsages(src, root)).toEqual([]);
	});

	it("ignores unrelated files and non-ts/tsx extensions", () => {
		const { root, src } = makeTmpSrc();
		writeFileSync(join(src, "notes.md"), "Promise.withResolvers()\n");
		writeFileSync(join(src, "clean.ts"), "export const ok = 1;\n");

		expect(findWithResolversUsages(src, root)).toEqual([]);
	});

	it("passes clean against the real src/ tree (regression for #14/#16)", () => {
		expect(findWithResolversUsages()).toEqual([]);
	});
});
