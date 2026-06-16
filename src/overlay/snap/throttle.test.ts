import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createThrottle } from "./throttle";

describe("createThrottle", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("N rapid calls within the window invoke fn exactly once (leading edge)", () => {
		const fn = vi.fn();
		const throttled = createThrottle(fn, 600);

		// Five rapid calls — only the first should fire.
		for (let i = 0; i < 5; i++) {
			throttled();
		}

		expect(fn).toHaveBeenCalledTimes(1);
	});

	it("a call after the window fires again", () => {
		const fn = vi.fn();
		const throttled = createThrottle(fn, 600);

		throttled(); // leading-edge fire #1
		expect(fn).toHaveBeenCalledTimes(1);

		// Calls within the window are suppressed.
		throttled();
		throttled();
		expect(fn).toHaveBeenCalledTimes(1);

		// Advance past the window — next call starts a new leading edge.
		vi.advanceTimersByTime(601);
		throttled(); // leading-edge fire #2
		expect(fn).toHaveBeenCalledTimes(2);
	});

	it("calls within the window are dropped, not deferred", () => {
		const fn = vi.fn();
		const throttled = createThrottle(fn, 600);

		throttled(); // fires immediately
		vi.advanceTimersByTime(300); // still inside window
		throttled(); // dropped
		vi.advanceTimersByTime(600); // now past window from first fire

		// No trailing call should have been queued.
		expect(fn).toHaveBeenCalledTimes(1);

		throttled(); // new leading edge
		expect(fn).toHaveBeenCalledTimes(2);
	});
});
