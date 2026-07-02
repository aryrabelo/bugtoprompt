/**
 * Pure crop/scale math for the screen grabber. getDisplayMedia is untestable
 * under jsdom, so the framing decision is factored into these pure functions
 * and unit-tested directly: tab-share detection tolerance, click-centered crop,
 * edge clamping, and the whole-frame downscale fallback.
 */
import { describe, expect, test } from "vitest";
import { computeCropRect, computeScaledSize, isTabShare } from "./screenshot";

describe("isTabShare", () => {
	test("frame ≈ innerWidth*dpr → tab share", () => {
		// 1440 CSS px viewport at dpr 2 → 2880 device px frame.
		expect(isTabShare(2880, 1440, 2)).toBe(true);
	});

	test("within 2% tolerance still counts as tab share", () => {
		expect(isTabShare(2900, 1440, 2)).toBe(true); // ~0.7% off
	});

	test("full-screen share (frame much wider than viewport) → not tab share", () => {
		// 1440 CSS px viewport at dpr 2 expects 2880; a 3840px monitor frame is way off.
		expect(isTabShare(3840, 1440, 2)).toBe(false);
	});

	test("dpr 1 viewport matches an equal-width frame", () => {
		expect(isTabShare(1280, 1280, 1)).toBe(true);
	});
});

describe("computeCropRect", () => {
	const viewport = { width: 1000, height: 800 };

	test("crop is centered on the mapped click point", () => {
		// dpr-equivalent scale = frameW/viewportW = 2000/1000 = 2.
		// Click at CSS (500,400) → frame (1000,800); box 600css*2 = 1200 frame px.
		const r = computeCropRect(2000, 1600, viewport, { x: 500, y: 400 }, 600);
		expect(r.sw).toBe(1200);
		expect(r.sh).toBe(1200);
		// centered: sx = 1000 - 600 = 400, sy = 800 - 600 = 200
		expect(r.sx).toBe(400);
		expect(r.sy).toBe(200);
	});

	test("clamps to the left/top edge when click is near a corner", () => {
		const r = computeCropRect(2000, 1600, viewport, { x: 0, y: 0 }, 600);
		expect(r.sx).toBe(0);
		expect(r.sy).toBe(0);
	});

	test("clamps to the right/bottom edge when click is near the far corner", () => {
		const r = computeCropRect(2000, 1600, viewport, { x: 1000, y: 800 }, 600);
		// box 1200; sx max = frameW - sw = 2000 - 1200 = 800; sy = 1600 - 1200 = 400
		expect(r.sx).toBe(800);
		expect(r.sy).toBe(400);
	});

	test("crop box never exceeds the frame (small frame)", () => {
		const r = computeCropRect(
			400,
			300,
			{ width: 400, height: 300 },
			{ x: 200, y: 150 },
			600,
		);
		expect(r.sw).toBe(400);
		expect(r.sh).toBe(300);
		expect(r.sx).toBe(0);
		expect(r.sy).toBe(0);
	});
});

describe("computeScaledSize", () => {
	test("downscales so the max dimension is ≤ maxDim", () => {
		const s = computeScaledSize(3840, 2160, 1280);
		expect(Math.max(s.width, s.height)).toBe(1280);
		expect(s.width).toBe(1280);
		expect(s.height).toBe(720); // aspect preserved
	});

	test("never upscales a frame already under the cap", () => {
		const s = computeScaledSize(800, 600, 1280);
		expect(s.width).toBe(800);
		expect(s.height).toBe(600);
	});

	test("tall frame scales on height", () => {
		const s = computeScaledSize(1000, 2560, 1280);
		expect(Math.max(s.width, s.height)).toBe(1280);
		expect(s.height).toBe(1280);
	});
});
