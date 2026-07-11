import { deferred } from "../util/deferred";

/**
 * Best-effort screen capture for a capture session. `getDisplayMedia` gives the
 * real composited pixels (canvas/WebGL/cross-origin included) — what the user
 * actually saw. The display stream is requested ONCE at record-start and kept;
 * each shortcut grabs a single frame. When the user denies screen share the
 * grabber is a no-op and screenshots are simply absent (the interactive snapshot
 * still pinpoints the element). No html2canvas dependency in v1.
 *
 * Framing: a full retina frame exported as PNG is multiple MB and blows the
 * hosted /artifact 5 MB cap. Instead we (a) crop a ~600 CSS-px box around the
 * user's click when the share is a browser TAB (frame ≈ page viewport), or
 * (b) downscale the whole frame to ≤1280px on a screen/monitor share, and
 * always encode JPEG q0.8. A tab-share crop is tens of KB.
 */

export interface ScreenGrab {
	blob: Blob;
	method: "getDisplayMedia";
}

export interface ScreenGrabber {
	/** True when a live display stream was acquired; false for the no-op grabber
	 *  (capture unavailable or the user denied the screen-share prompt). Lets the
	 *  session surface a non-blocking "Screenshots unavailable" status. */
	available: boolean;
	/** Grab one JPEG frame; null when capture is unavailable or encoding fails.
	 *  With `input` (a click point in viewport CSS coords + its 1-based
	 *  clickNumber) on a tab share, the frame is cropped to an exact
	 *  CLICK_CROP_WIDTH_CSS×CLICK_CROP_HEIGHT_CSS image with the click centered
	 *  and a numbered marker drawn on it; otherwise the whole frame is
	 *  downscaled (route/manual Mark). */
	grab(input?: {
		point: { x: number; y: number };
		clickNumber: number;
	}): Promise<ScreenGrab | null>;
	stop(): void;
}

/** Longest edge (device px) of the downscaled whole-frame fallback. Sized for
 *  an AI agent's context window, not a human display. */
const FALLBACK_MAX_DIM = 1024;
/** Fixed click-crop dimensions in CSS px. Every click screenshot is exactly
 *  this size so the click stays geometrically centered and thumbnails are
 *  uniform. */
export const CLICK_CROP_WIDTH_CSS = 400;
export const CLICK_CROP_HEIGHT_CSS = 600;
/** Destination center of the crop — where the click (and its numbered marker)
 *  always lands, even when the source crop hits a viewport edge. */
export const CLICK_CENTER_X = CLICK_CROP_WIDTH_CSS / 2;
export const CLICK_CENTER_Y = CLICK_CROP_HEIGHT_CSS / 2;
/** Neutral fill for uncovered pixels when the crop extends past the frame —
 *  matches the overlay's dark background so padding is unobtrusive. */
const CROP_PAD_COLOR = "#1a1d29";
/** JPEG quality ladder for click crops. The canvas stays exactly
 *  CLICK_CROP_WIDTH_CSS×CLICK_CROP_HEIGHT_CSS — only quality varies so output
 *  dimensions never change. */
const CLICK_QUALITY_STEPS: ReadonlyArray<number> = [0.8, 0.7, 0.6];
/** Re-encode the frame until the JPEG fits an AI context window (~300 KB) —
 *  these images feed a model, not a human eye. Each step is [destScale,
 *  quality]; the first result under the cap wins, else the smallest (last) is
 *  used. Typical shots land 50–150 KB. */
const TARGET_MAX_BYTES = 300_000;
const ENCODE_STEPS: ReadonlyArray<[number, number]> = [
	[1, 0.8],
	[1, 0.7],
	[1, 0.6],
	[0.75, 0.6],
	[0.5, 0.6],
];

/**
 * Tab shares composite the page viewport, so the frame width ≈ innerWidth ×
 * devicePixelRatio. A screen/window share does not track the viewport. Compare
 * within `tol` (fractional) to tell them apart.
 */
export function isTabShare(
	frameW: number,
	viewportW: number,
	dpr: number,
	tol = 0.02,
): boolean {
	const expected = viewportW * dpr;
	if (expected <= 0) return false;
	return Math.abs(frameW - expected) / expected <= tol;
}

/**
 * Framing for a fixed CLICK_CROP_WIDTH_CSS×CLICK_CROP_HEIGHT_CSS click crop.
 *
 * Returns the source rectangle in frame px (the pixels actually available from
 * the captured tab) together with the destination offset/size in CSS px (=
 * output px) at which to draw them. When the desired crop extends past a
 * viewport edge the source is clamped and the destination offset grows so the
 * click stays at the exact destination center (CLICK_CENTER_X, CLICK_CENTER_Y);
 * the uncovered destination pixels are left for the caller to fill with a
 * neutral background. `scale` maps CSS px → frame px via frameW / viewport.width.
 */
export function computeCropRect(
	frameW: number,
	frameH: number,
	viewport: { width: number; height: number },
	point: { x: number; y: number },
	widthCss = CLICK_CROP_WIDTH_CSS,
	heightCss = CLICK_CROP_HEIGHT_CSS,
): {
	sx: number;
	sy: number;
	sw: number;
	sh: number;
	dx: number;
	dy: number;
	dw: number;
	dh: number;
} {
	const scale = viewport.width > 0 ? frameW / viewport.width : 1;
	// Desired crop rect in CSS coords, centered on the click.
	const left = point.x - widthCss / 2;
	const top = point.y - heightCss / 2;
	// Intersect with the available viewport region [0..width]×[0..height].
	const availL = Math.max(left, 0);
	const availT = Math.max(top, 0);
	const availR = Math.min(left + widthCss, viewport.width);
	const availB = Math.min(top + heightCss, viewport.height);
	const availW = Math.max(0, availR - availL);
	const availH = Math.max(0, availB - availT);
	// Destination offset: how far into the fixed output the covered region sits.
	const dx = Math.round(availL - left);
	const dy = Math.round(availT - top);
	const dw = Math.round(availW);
	const dh = Math.round(availH);
	// Source rect in frame px, clamped to the frame bounds.
	const sx = Math.round(availL * scale);
	const sy = Math.round(availT * scale);
	const sw = Math.min(Math.round(availW * scale), frameW - sx);
	const sh = Math.min(Math.round(availH * scale), frameH - sy);
	return { sx, sy, sw, sh, dx, dy, dw, dh };
}

/** Downscale so the longest edge is ≤ `maxDim`; never upscales. */
export function computeScaledSize(
	frameW: number,
	frameH: number,
	maxDim = FALLBACK_MAX_DIM,
): { width: number; height: number } {
	const longest = Math.max(frameW, frameH);
	if (longest <= maxDim) return { width: frameW, height: frameH };
	const scale = maxDim / longest;
	return {
		width: Math.round(frameW * scale),
		height: Math.round(frameH * scale),
	};
}

const NULL_GRABBER: ScreenGrabber = {
	available: false,
	async grab() {
		return null;
	},
	stop() {},
};

/** Encode a canvas to a JPEG blob, walking the quality ladder until it fits the
 *  byte cap; keeps the smallest result if even the last step is over. */
async function encodeCanvas(
	canvas: HTMLCanvasElement,
	qualities: ReadonlyArray<number>,
): Promise<Blob | null> {
	let blob: Blob | null = null;
	for (const quality of qualities) {
		const { promise, resolve } = deferred<Blob | null>();
		canvas.toBlob((b) => resolve(b), "image/jpeg", quality);
		const step = await promise;
		if (step) blob = step;
		if (step && step.size <= TARGET_MAX_BYTES) break;
	}
	return blob;
}

/** Draw a numbered marker at the destination center so the screenshot is
 *  visibly linked to its timeline click number. */
function drawClickMarker(
	ctx: CanvasRenderingContext2D,
	clickNumber: number,
): void {
	const r = 16;
	ctx.save();
	ctx.beginPath();
	ctx.arc(CLICK_CENTER_X, CLICK_CENTER_Y, r, 0, Math.PI * 2);
	ctx.fillStyle = "rgba(220, 38, 38, 0.9)";
	ctx.fill();
	ctx.lineWidth = 2;
	ctx.strokeStyle = "#ffffff";
	ctx.stroke();
	ctx.fillStyle = "#ffffff";
	ctx.font = "bold 18px sans-serif";
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	ctx.fillText(String(clickNumber), CLICK_CENTER_X, CLICK_CENTER_Y);
	ctx.restore();
}

function stopStream(stream: MediaStream): void {
	for (const track of stream.getTracks()) track.stop();
}

/**
 * Request the display stream once; returns a grabber that snapshots frames on
 * demand. Returns a no-op grabber when screen capture is unavailable or denied.
 */
export async function startScreenGrabber(): Promise<ScreenGrabber> {
	const media = navigator.mediaDevices;
	if (!media?.getDisplayMedia) return NULL_GRABBER;

	let stream: MediaStream;
	try {
		// preferCurrentTab/selfBrowserSurface nudge the picker toward a tab share
		// so the click-crop path is the common case. Cast: not in every lib.dom.
		stream = await media.getDisplayMedia({
			video: { frameRate: 1 },
			audio: false,
			preferCurrentTab: true,
			selfBrowserSurface: "include",
		} as DisplayMediaStreamOptions);
	} catch {
		return NULL_GRABBER; // user denied the screen-share prompt
	}
	const track = stream.getVideoTracks()[0];
	if (!track) {
		stopStream(stream);
		return NULL_GRABBER;
	}

	const video = document.createElement("video");
	video.srcObject = stream;
	video.muted = true;
	await video.play().catch(() => undefined);

	return {
		available: true,
		async grab(input) {
			const settings = track.getSettings();
			const frameW = settings.width ?? video.videoWidth ?? window.innerWidth;
			const frameH = settings.height ?? video.videoHeight ?? window.innerHeight;
			if (!frameW || !frameH) return null;

			const dpr = window.devicePixelRatio || 1;
			const viewport = { width: window.innerWidth, height: window.innerHeight };

			const canvas = document.createElement("canvas");
			const ctx = canvas.getContext("2d");
			if (!ctx) return null;

			// Click on a tab share → fixed CLICK_CROP_WIDTH_CSS×CLICK_CROP_HEIGHT_CSS
			// output in CSS px (DPR-independent), click centered, numbered marker on
			// top; uncovered edge pixels filled neutral. Only quality varies so the
			// output dimensions stay exact.
			if (input && isTabShare(frameW, viewport.width, dpr)) {
				const r = computeCropRect(frameW, frameH, viewport, input.point);
				canvas.width = CLICK_CROP_WIDTH_CSS;
				canvas.height = CLICK_CROP_HEIGHT_CSS;
				ctx.fillStyle = CROP_PAD_COLOR;
				ctx.fillRect(0, 0, CLICK_CROP_WIDTH_CSS, CLICK_CROP_HEIGHT_CSS);
				if (r.sw > 0 && r.sh > 0 && r.dw > 0 && r.dh > 0) {
					ctx.drawImage(video, r.sx, r.sy, r.sw, r.sh, r.dx, r.dy, r.dw, r.dh);
				}
				drawClickMarker(ctx, input.clickNumber);
				const blob = await encodeCanvas(canvas, CLICK_QUALITY_STEPS);
				return blob ? { blob, method: "getDisplayMedia" } : null;
			}

			// Route/manual Mark (no click point) → downscale the whole frame, walking
			// the [scale, quality] ladder until the JPEG fits the AI-context cap.
			const dest = computeScaledSize(frameW, frameH);
			let blob: Blob | null = null;
			for (const [scale, quality] of ENCODE_STEPS) {
				const dw = Math.max(1, Math.round(dest.width * scale));
				const dh = Math.max(1, Math.round(dest.height * scale));
				canvas.width = dw;
				canvas.height = dh;
				ctx.drawImage(video, 0, 0, frameW, frameH, 0, 0, dw, dh);
				blob = await encodeCanvas(canvas, [quality]);
				if (blob && blob.size <= TARGET_MAX_BYTES) break;
			}
			return blob ? { blob, method: "getDisplayMedia" } : null;
		},
		stop() {
			stopStream(stream);
		},
	};
}
