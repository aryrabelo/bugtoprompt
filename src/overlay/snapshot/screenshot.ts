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
	/** Grab one JPEG frame; null when capture is unavailable. When `point`
	 *  (viewport CSS coords of the click) is given and the share is a tab, the
	 *  frame is cropped around it; otherwise the whole frame is downscaled. */
	grab(point?: { x: number; y: number }): Promise<ScreenGrab | null>;
	stop(): void;
}

/** Longest edge (device px) of the downscaled whole-frame fallback. Sized for
 *  an AI agent's context window, not a human display. */
const FALLBACK_MAX_DIM = 1024;
/** Crop box edge in CSS px, centered on the click, for tab shares. */
const CROP_BOX_CSS = 600;
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
 * A source-rect (frame px) for a `boxCss`-sized crop centered on `point`
 * (viewport CSS coords), clamped to the frame. `scale` maps CSS px → frame px
 * via frameW / viewport.width.
 */
export function computeCropRect(
	frameW: number,
	frameH: number,
	viewport: { width: number; height: number },
	point: { x: number; y: number },
	boxCss = CROP_BOX_CSS,
): { sx: number; sy: number; sw: number; sh: number } {
	const scale = viewport.width > 0 ? frameW / viewport.width : 1;
	const sw = Math.min(Math.round(boxCss * scale), frameW);
	const sh = Math.min(Math.round(boxCss * scale), frameH);
	const cx = point.x * scale;
	const cy = point.y * scale;
	const sx = Math.round(Math.max(0, Math.min(cx - sw / 2, frameW - sw)));
	const sy = Math.round(Math.max(0, Math.min(cy - sh / 2, frameH - sh)));
	return { sx, sy, sw, sh };
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
	async grab() {
		return null;
	},
	stop() {},
};

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
		async grab(point) {
			const settings = track.getSettings();
			const frameW = settings.width ?? video.videoWidth ?? window.innerWidth;
			const frameH = settings.height ?? video.videoHeight ?? window.innerHeight;
			if (!frameW || !frameH) return null;

			const dpr = window.devicePixelRatio || 1;
			const viewport = { width: window.innerWidth, height: window.innerHeight };

			// Source rect (frame px) + base destination size. Tab share + a click
			// point → crop around the click at full resolution; otherwise downscale
			// the whole frame.
			let src: { sx: number; sy: number; sw: number; sh: number };
			let dest: { width: number; height: number };
			if (point && isTabShare(frameW, viewport.width, dpr)) {
				const r = computeCropRect(frameW, frameH, viewport, point);
				src = r;
				dest = { width: r.sw, height: r.sh };
			} else {
				src = { sx: 0, sy: 0, sw: frameW, sh: frameH };
				dest = computeScaledSize(frameW, frameH);
			}

			const canvas = document.createElement("canvas");
			const ctx = canvas.getContext("2d");
			if (!ctx) return null;

			// Re-encode down the [scale, quality] ladder until the JPEG fits the
			// AI-context byte cap; keep the smallest if even the last step is over.
			let blob: Blob | null = null;
			for (const [scale, quality] of ENCODE_STEPS) {
				const dw = Math.max(1, Math.round(dest.width * scale));
				const dh = Math.max(1, Math.round(dest.height * scale));
				canvas.width = dw;
				canvas.height = dh;
				ctx.drawImage(video, src.sx, src.sy, src.sw, src.sh, 0, 0, dw, dh);
				const { promise, resolve } = deferred<Blob | null>();
				canvas.toBlob((b) => resolve(b), "image/jpeg", quality);
				const step = await promise;
				if (step) blob = step;
				if (step && step.size <= TARGET_MAX_BYTES) break;
			}
			return blob ? { blob, method: "getDisplayMedia" } : null;
		},
		stop() {
			stopStream(stream);
		},
	};
}
