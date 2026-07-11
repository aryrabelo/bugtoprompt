/**
 * Localhost content script. Its sole job is to tell the service worker that a
 * fresh document is ready after every full navigation, so an active tab can
 * have its overlay reinjected (the new document has no MAIN-world singleton).
 * It never touches the page DOM or the overlay itself.
 */

import type { ChromeLike } from "./config";

export function notifyDocumentReady(chromeApi: ChromeLike): void {
	void chromeApi.runtime?.sendMessage?.({ type: "btp:document-ready" });
}

declare const chrome: ChromeLike;
const maybeChrome = typeof chrome !== "undefined" ? chrome : undefined;
if (maybeChrome?.runtime) {
	notifyDocumentReady(maybeChrome);
}
