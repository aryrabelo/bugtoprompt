/**
 * Leading-edge throttle with burst coalescing.
 *
 * The wrapped function fires immediately on the first call (leading edge);
 * subsequent calls within `windowMs` are silently dropped. A call arriving
 * after the window starts a new leading edge.
 *
 * Pure and testable — no React, no DOM.
 */
export function createThrottle(fn: () => void, windowMs: number): () => void {
	let lastFired = Number.NEGATIVE_INFINITY;
	return (): void => {
		const now = Date.now();
		if (now - lastFired >= windowMs) {
			lastFired = now;
			fn();
		}
	};
}
