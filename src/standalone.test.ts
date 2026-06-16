/**
 * Smoke test for the standalone entry's mount/unmount cycle.
 *
 * The standalone module runs side-effects at evaluation time (auto-mount logic).
 * We must set window.__SNAP_PROMPT__.manual = true BEFORE the module loads so
 * auto-mount is suppressed. This requires vi.resetModules() + dynamic import —
 * an explicit exception to ts-no-dynamic-import: the test is intentionally
 * exercising module loading boundaries.
 */
import "fake-indexeddb/auto";
import { act } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// Mock the CSS import before the standalone module is loaded.
// Static mock hoisting ensures this runs before any `import "./standalone"`.
vi.mock("../dist/snap-prompt.css", () => ({
	default: "/* standalone smoke */",
}));

beforeEach(() => {
	// Suppress auto-mount so tests control mount() themselves.
	// Must be set before the module is loaded (enforced by resetModules below).
	window.__SNAP_PROMPT__ = { manual: true };
	vi.resetModules();
});

afterEach(() => {
	// Clean up any mounted container and style tag between tests.
	for (const el of Array.from(
		document.querySelectorAll("[data-snap-prompt-style]"),
	)) {
		el.remove();
	}
	// Unmount via window.SnapPrompt if still mounted.
	window.SnapPrompt?.unmount();
	window.__SNAP_PROMPT__ = undefined;
});

it("mount() injects <style data-snap-prompt-style> and a [data-snap-prompt] element", async () => {
	// Dynamic import AFTER window.__SNAP_PROMPT__ is set — required so the
	// module-level auto-mount guard sees manual:true on first evaluation.
	// Exception to ts-no-dynamic-import: module-loading boundary test.
	const { mount } = await import("./standalone");

	await act(async () => {
		mount();
	});

	expect(document.querySelector("[data-snap-prompt-style]")).not.toBeNull();
	expect(document.querySelector("[data-snap-prompt]")).not.toBeNull();
});

it("unmount() removes the container but leaves the stylesheet", async () => {
	const { mount, unmount } = await import("./standalone");

	await act(async () => {
		mount();
	});

	// Baseline — overlay is present.
	expect(document.querySelector("[data-snap-prompt]")).not.toBeNull();

	await act(async () => {
		unmount();
	});

	// Container gone — no more [data-snap-prompt] portals.
	expect(document.querySelector("[data-snap-prompt]")).toBeNull();
	// Stylesheet persists (singleton, intentional).
	expect(document.querySelector("[data-snap-prompt-style]")).not.toBeNull();
});

it("mount() is idempotent — calling twice mounts only one container", async () => {
	const { mount } = await import("./standalone");

	await act(async () => {
		mount();
		mount(); // second call must be a no-op
	});

	// Only one style tag injected.
	expect(document.querySelectorAll("[data-snap-prompt-style]").length).toBe(1);
});
