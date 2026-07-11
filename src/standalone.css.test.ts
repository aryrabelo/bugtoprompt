/**
 * P0-5: the overlay stylesheet must disable `animate-pulse` under
 * prefers-reduced-motion so the recording/caption status dots stop pulsing.
 * Both build paths (build:css → dist/bugtoprompt.css, and the standalone IIFE
 * which inlines that same output) compile from this single source file, so
 * asserting the rule here locks coverage for both.
 */
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("disables .animate-pulse under prefers-reduced-motion, scoped to the overlay", () => {
	const css = readFileSync("src/standalone.css", "utf8");
	// Collapse whitespace so the assertion is robust to formatting.
	const flat = css.replace(/\s+/g, " ");
	expect(flat).toMatch(
		/@media \(prefers-reduced-motion: reduce\) \{ \[data-bugtoprompt\] \.animate-pulse \{ animation: none; \}/,
	);
});
