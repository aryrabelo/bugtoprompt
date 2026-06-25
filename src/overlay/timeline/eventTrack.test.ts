import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CaptureEvent } from "../../schema";
import { installEventTrack } from "./eventTrack";

/**
 * mouse-down leaves a placeholder; mouse-up resolves it into a `click` or — when
 * the user highlighted text — a `select` carrying that text, anchored at the
 * mouse-down time so it lines up with the narration.
 */
describe("installEventTrack — clicks & selections", () => {
	let events: CaptureEvent[];
	let cleanup: () => void;
	let now: number;
	let target: HTMLButtonElement;

	const mockSelection = (text: string): void => {
		vi.spyOn(window, "getSelection").mockReturnValue({
			toString: () => text,
		} as Selection);
	};
	const down = (el: Element, t: number): void => {
		now = t;
		el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
	};
	const up = (el: Element, t: number): void => {
		now = t;
		el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
	};

	beforeEach(() => {
		events = [];
		now = 0;
		document.body.innerHTML = "";
		target = document.createElement("button");
		target.textContent = "Save";
		document.body.appendChild(target);
		cleanup = installEventTrack({
			onEvent: (e) => events.push(e),
			elapsedMs: () => now,
		});
	});

	afterEach(() => {
		cleanup?.();
		vi.restoreAllMocks();
	});

	it("emits a click anchored at the mouse-down time when nothing is selected", () => {
		mockSelection("");
		down(target, 100);
		up(target, 250);
		expect(events).toHaveLength(1);
		expect(events[0].kind).toBe("click");
		expect(events[0].tMs).toBe(100); // down time, not up time
		expect(events[0].selectedText).toBeUndefined();
	});

	it("emits a select with the highlighted text (trimmed) on mouse-up", () => {
		mockSelection("  essa parte aqui  ");
		down(target, 70);
		up(target, 300);
		expect(events).toHaveLength(1);
		expect(events[0].kind).toBe("select");
		expect(events[0].selectedText).toBe("essa parte aqui");
		expect(events[0].tMs).toBe(70);
	});

	it("emits a click for a keyboard activation (detail 0)", () => {
		now = 42;
		target.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 }));
		expect(events).toHaveLength(1);
		expect(events[0].kind).toBe("click");
		expect(events[0].tMs).toBe(42);
	});

	it("does not double-emit when the browser fires click after a mouse-up", () => {
		mockSelection("");
		down(target, 1);
		up(target, 2);
		now = 3;
		// Real browsers fire a detail>=1 click after mouseup; it must be ignored.
		target.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
		expect(events).toHaveLength(1);
		expect(events[0].kind).toBe("click");
	});

	it("ignores interactions inside the overlay's own UI", () => {
		mockSelection("");
		const overlay = document.createElement("div");
		overlay.setAttribute("data-bugtoprompt", "");
		const inner = document.createElement("button");
		overlay.appendChild(inner);
		document.body.appendChild(overlay);
		down(inner, 10);
		up(inner, 20);
		expect(events).toHaveLength(0);
	});

	it("caps a very long selection", () => {
		mockSelection("x".repeat(1000));
		down(target, 5);
		up(target, 9);
		expect(events[0].selectedText).toHaveLength(500);
	});
});
