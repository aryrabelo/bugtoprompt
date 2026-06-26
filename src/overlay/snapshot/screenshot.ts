import { deferred } from "../util/deferred";

/**
 * Best-effort screen capture for a capture session. `getDisplayMedia` gives the
 * real composited pixels (canvas/WebGL/cross-origin included) — what the user
 * actually saw. The display stream is requested ONCE at record-start and kept;
 * each shortcut grabs a single frame. When the user denies screen share the
 * grabber is a no-op and screenshots are simply absent (the interactive snapshot
 * still pinpoints the element). No html2canvas dependency in v1.
 */

export interface ScreenGrab {
	blob: Blob;
	method: "getDisplayMedia";
}

export interface ScreenGrabber {
	/** Grab one PNG frame; null when capture is unavailable. */
	grab(): Promise<ScreenGrab | null>;
	stop(): void;
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
		stream = await media.getDisplayMedia({
			video: { frameRate: 1 },
			audio: false,
		});
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
		async grab() {
			const settings = track.getSettings();
			const width = settings.width ?? video.videoWidth ?? window.innerWidth;
			const height = settings.height ?? video.videoHeight ?? window.innerHeight;
			if (!width || !height) return null;
			const canvas = document.createElement("canvas");
			canvas.width = width;
			canvas.height = height;
			const ctx = canvas.getContext("2d");
			if (!ctx) return null;
			ctx.drawImage(video, 0, 0, width, height);
			const { promise, resolve } = deferred<Blob | null>();
			canvas.toBlob((b) => resolve(b), "image/png");
			const blob = await promise;
			return blob ? { blob, method: "getDisplayMedia" } : null;
		},
		stop() {
			stopStream(stream);
		},
	};
}
