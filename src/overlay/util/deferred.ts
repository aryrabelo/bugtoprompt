/**
 * Node-18-compatible alternative to `Promise.withResolvers()` (ES2024).
 * Returns the promise alongside its resolve/reject handles so callers can
 * settle it from outside the executor — the same pattern, without the
 * availability gap.
 */
export function deferred<T>(): {
	promise: Promise<T>;
	resolve: (v: T) => void;
	reject: (e?: unknown) => void;
} {
	let resolve!: (v: T) => void;
	let reject!: (e?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}
