/**
 * Pure crop/scale math for the screen grabber. getDisplayMedia is untestable
 * under jsdom, so the framing decision is factored into these pure functions
 * and unit-tested directly: tab-share detection tolerance, the fixed
 * 400×600 click-centered crop (with neutral-padding offsets at the edges),
 * DPR independence of the output, and the whole-frame downscale fallback.
 */
import { describe, expect, test } from "vitest";
import {
	CLICK_CROP_HEIGHT_CSS,
	CLICK_CROP_WIDTH_CSS,
	computeCropRect,
	computeScaledSize,
	isTabShare,
} from "./screenshot";

describe("isTabShare", () => {
	test("frame ≈ innerWidth*dpr → tab share", () => {
		expect(isTabShare(2880, 1440, 2)).toBe(true);
	});

	test("within 2% tolerance still counts as tab share", () => {
		expect(isTabShare(2900, 1440, 2)).toBe(true); // ~0.7% off
	});

	test("full-screen share (frame much wider than viewport) → not tab share", () => {
		expect(isTabShare(3840, 1440, 2)).toBe(false);
	});

	test("dpr 1 viewport matches an equal-width frame", () => {
		expect(isTabShare(1280, 1280, 1)).toBe(true);
	});
});

describe("computeCropRect — fixed 400×600 click crop", () => {
	const viewport = { width: 1000, height: 800 };

	test("crop constants are 400×600", () => {
		expect(CLICK_CROP_WIDTH_CSS).toBe(400);
		expect(CLICK_CROP_HEIGHT_CSS).toBe(600);
	});

	test("center click: full crop, drawn at offset 0, click stays at (200,300)", () => {
		// dpr scale = frameW/viewportW = 2000/1000 = 2.
		const r = computeCropRect(2000, 1600, viewport, { x: 500, y: 400 });
		// Whole 400×600 is covered → destination offset 0, full dest size.
		expect(r.dx).toBe(0);
		expect(r.dy).toBe(0);
		expect(r.dw).toBe(400);
		expect(r.dh).toBe(600);
		// Source rect (frame px): 400css*2=800 wide, 600css*2=1200 tall, centered.
		expect(r.sw).toBe(800);
		expect(r.sh).toBe(1200);
		expect(r.sx).toBe((500 - 200) * 2); // 600
		expect(r.sy).toBe((400 - 300) * 2); // 200
		// Click destination = dx + (clickCss - availLCss) → 0 + (500-300) = 200 ✓
		expect(r.dx + (500 - r.sx / 2)).toBe(200);
	});

	test("top-left corner click pads left/top, keeps click centered", () => {
		const r = computeCropRect(2000, 1600, viewport, { x: 0, y: 0 });
		// Desired left/top = -200/-300 → offset by exactly the missing half.
		expect(r.dx).toBe(200);
		expect(r.dy).toBe(300);
		// Only the bottom-right quadrant of the crop is covered.
		expect(r.dw).toBe(200);
		expect(r.dh).toBe(300);
		expect(r.sx).toBe(0);
		expect(r.sy).toBe(0);
		expect(r.sw).toBe(400); // 200css * 2
		expect(r.sh).toBe(600); // 300css * 2
		// Click (0,0) lands at destination (dx + 0, dy + 0) = (200, 300) ✓
		expect(r.dx).toBe(200);
		expect(r.dy).toBe(300);
	});

	test("bottom-right corner click pads right/bottom, keeps click centered", () => {
		const r = computeCropRect(2000, 1600, viewport, { x: 1000, y: 800 });
		expect(r.dx).toBe(0);
		expect(r.dy).toBe(0);
		expect(r.dw).toBe(200); // only left/top half of the box is inside
		expect(r.dh).toBe(300);
		// Click (1000,800) lands at dest (dx + (1000-availL), dy + (800-availT))
		// availL = 800, availT = 500 → (0 + 200, 0 + 300) = (200,300) ✓
		expect(r.dx + (1000 - r.sx / 2)).toBe(200);
		expect(r.dy + (800 - r.sy / 2)).toBe(300);
	});

	test("left edge (mid-height): pads left only", () => {
		const r = computeCropRect(2000, 1600, viewport, { x: 0, y: 400 });
		expect(r.dx).toBe(200); // left half uncovered
		expect(r.dy).toBe(0); // vertically fully inside
		expect(r.dw).toBe(200);
		expect(r.dh).toBe(600);
	});

	test("right edge (mid-height): pads right only", () => {
		const r = computeCropRect(2000, 1600, viewport, { x: 1000, y: 400 });
		expect(r.dx).toBe(0);
		expect(r.dw).toBe(200);
		expect(r.dh).toBe(600);
	});

	test("DPR independence: DPR1 and DPR2 give identical destination geometry", () => {
		const dpr1 = computeCropRect(1000, 800, viewport, { x: 500, y: 400 });
		const dpr2 = computeCropRect(2000, 1600, viewport, { x: 500, y: 400 });
		// Destination (output) rect is CSS-sized → identical regardless of DPR.
		expect(dpr1.dx).toBe(dpr2.dx);
		expect(dpr1.dy).toBe(dpr2.dy);
		expect(dpr1.dw).toBe(dpr2.dw);
		expect(dpr1.dh).toBe(dpr2.dh);
		// Source rect scales with DPR.
		expect(dpr2.sw).toBe(dpr1.sw * 2);
		expect(dpr2.sh).toBe(dpr1.sh * 2);
	});

	test("destination rect never exceeds the fixed 400×600 output", () => {
		for (const p of [
			{ x: 0, y: 0 },
			{ x: 1000, y: 800 },
			{ x: 500, y: 400 },
			{ x: 0, y: 800 },
			{ x: 1000, y: 0 },
		]) {
			const r = computeCropRect(2000, 1600, viewport, p);
			expect(r.dx).toBeGreaterThanOrEqual(0);
			expect(r.dy).toBeGreaterThanOrEqual(0);
			expect(r.dx + r.dw).toBeLessThanOrEqual(CLICK_CROP_WIDTH_CSS);
			expect(r.dy + r.dh).toBeLessThanOrEqual(CLICK_CROP_HEIGHT_CSS);
		}
	});
});

describe("computeCropRect — anisotropic frame/viewport aspect ratios", () => {
	// Width ratio 2x (800/400), height ratio 2.5x (1000/400). The vertical
	// source math must use the height-based scale, not the horizontal one.
	test("sy/sh use height scale, sx/sw use width scale", () => {
		const r = computeCropRect(
			800,
			1000,
			{ width: 400, height: 400 },
			{ x: 300, y: 350 },
		);
		// Horizontal: availL=100, availW=300 → ×2
		expect(r.sx).toBe(200);
		expect(r.sw).toBe(600);
		// Vertical: availT=50, availH=350 → ×2.5 (buggy width-scale would give 100/700)
		expect(r.sy).toBe(125);
		expect(r.sh).toBe(875);
	});
});

describe("computeScaledSize", () => {
	test("downscales so the max dimension is ≤ maxDim", () => {
		const s = computeScaledSize(3840, 2160, 1280);
		expect(Math.max(s.width, s.height)).toBe(1280);
		expect(s.width).toBe(1280);
		expect(s.height).toBe(720);
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
