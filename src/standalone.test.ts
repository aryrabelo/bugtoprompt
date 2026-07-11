/**
 * Smoke test for the standalone entry's mount/unmount cycle.
 *
 * The standalone module runs side-effects at evaluation time (auto-mount logic).
 * We must set window.__BUGTOPROMPT__.manual = true BEFORE the module loads so
 * auto-mount is suppressed. This requires vi.resetModules() + dynamic import —
 * an explicit exception to ts-no-dynamic-import: the test is intentionally
 * exercising module loading boundaries.
 */
import "fake-indexeddb/auto";
import { act } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// Mock the CSS import before the standalone module is loaded.
// Static mock hoisting ensures this runs before any `import "./standalone"`.
vi.mock("../dist/bugtoprompt.css", () => ({
	default: "/* standalone smoke */",
}));

beforeEach(() => {
	// Suppress auto-mount so tests control mount() themselves.
	// Must be set before the module is loaded (enforced by resetModules below).
	window.__BUGTOPROMPT__ = { manual: true };
	vi.resetModules();
});

afterEach(() => {
	// Unmount via window.BugToPrompt if still mounted; the shadow host carries
	// the stylesheet, so removing it cleans everything.
	window.BugToPrompt?.unmount();
	for (const el of Array.from(
		document.querySelectorAll("[data-bugtoprompt-host]"),
	)) {
		el.remove();
	}
	window.__BUGTOPROMPT__ = undefined;
});

/** The overlay lives in a shadow root on the [data-bugtoprompt-host] element;
 *  document queries do not pierce it, so tests query through shadowRoot. */
function shadow(): ShadowRoot | null {
	const host = document.querySelector("[data-bugtoprompt-host]");
	return host?.shadowRoot ?? null;
}

it("mount() creates a shadow host with scoped styles and the overlay inside", async () => {
	// Dynamic import AFTER window.__BUGTOPROMPT__ is set — required so the
	// module-level auto-mount guard sees manual:true on first evaluation.
	// Exception to ts-no-dynamic-import: module-loading boundary test.
	const { mount } = await import("./standalone");

	await act(async () => {
		mount();
	});

	// Nothing leaks into the host document: no style tag, no overlay element.
	expect(document.querySelector("[data-bugtoprompt-style]")).toBeNull();
	expect(document.querySelector("[data-bugtoprompt]")).toBeNull();
	// Everything lives inside the shadow root.
	expect(shadow()?.querySelector("[data-bugtoprompt-style]")).not.toBeNull();
	expect(shadow()?.querySelector("[data-bugtoprompt]")).not.toBeNull();
});

it("unmount() removes the shadow host entirely", async () => {
	const { mount, unmount } = await import("./standalone");

	await act(async () => {
		mount();
	});

	// Baseline — overlay is present inside the shadow root.
	expect(shadow()?.querySelector("[data-bugtoprompt]")).not.toBeNull();

	await act(async () => {
		unmount();
	});

	// Host (and with it styles + overlay) gone from the document.
	expect(document.querySelector("[data-bugtoprompt-host]")).toBeNull();
});

it("mount() is idempotent — calling twice mounts only one shadow host", async () => {
	const { mount } = await import("./standalone");

	await act(async () => {
		mount();
		mount(); // second call must be a no-op
	});

	expect(document.querySelectorAll("[data-bugtoprompt-host]").length).toBe(1);
});
