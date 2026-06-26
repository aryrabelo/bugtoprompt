/**
 * Gated debug logger shared across the overlay pipeline and the client layer.
 * Enable in the browser console:
 *   localStorage.setItem("BUGTOPROMPT_DEBUG", "1")   // then reload
 *   // or, transiently:  window.__BUGTOPROMPT_DEBUG__ = true
 * Off by default so production consumers see a silent library.
 */
export function debug(...args: unknown[]): void {
	try {
		const w =
			typeof window !== "undefined"
				? (window as unknown as Record<string, unknown>)
				: undefined;
		const on =
			!!w &&
			(w.__BUGTOPROMPT_DEBUG__ === true ||
				(typeof localStorage !== "undefined" &&
					localStorage.getItem("BUGTOPROMPT_DEBUG") === "1"));
		if (on) console.log("[bugtoprompt]", ...args);
	} catch {
		/* never throw from logging */
	}
}
