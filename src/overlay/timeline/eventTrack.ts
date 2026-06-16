/**
 * The in-page event track: timestamped clicks, route changes, and manual marks,
 * relative to record-start. Clicks resolve the nearest interactive ancestor and
 * record its selector (+ snapshot ref when the session can map it). Route changes
 * cover TanStack Router (which drives `history.pushState`) and the standalone
 * `history`/`popstate` path, so this works inside Windhover and on any page.
 */
import type { CaptureEvent } from "../../schema";
import {
	accessibleName,
	interactiveRole,
} from "../snapshot/buildInteractiveSnapshot";
import { cssSelector } from "../snapshot/selector";

const INTERACTIVE =
	"a,button,input,select,textarea,summary,[role],[tabindex],[contenteditable]";

export interface EventTrackOptions {
	onEvent: (event: CaptureEvent) => void;
	/** Milliseconds since record-start. */
	elapsedMs: () => number;
	/** Map a clicked element to a snapshot ref, when known. */
	resolveRef?: (el: Element) => string | undefined;
	win?: Window;
}

/** Install the listeners; returns a cleanup that fully unwinds them (including
 *  the `history.pushState` monkeypatch). */
export function installEventTrack(opts: EventTrackOptions): () => void {
	const win = opts.win ?? window;

	const onClick = (ev: Event): void => {
		const target = ev.target as Element | null;
		if (target?.nodeType !== 1) return;
		// Never record interactions with the overlay's own UI.
		if (target.closest?.("[data-snap-prompt]")) return;
		const el = target.closest?.(INTERACTIVE) ?? target;
		const ref = opts.resolveRef?.(el);
		// Name + role captured at click time, so the issue caption can describe the
		// element without shipping full DOM snapshots.
		const name = accessibleName(el);
		const role = interactiveRole(el);
		opts.onEvent({
			tMs: opts.elapsedMs(),
			kind: "click",
			selector: cssSelector(el),
			...(name ? { elementName: name } : {}),
			...(role ? { elementRole: role } : {}),
			...(ref ? { elementRef: ref } : {}),
		});
	};
	win.document.addEventListener("click", onClick, true);

	const onRoute = (): void => {
		opts.onEvent({
			tMs: opts.elapsedMs(),
			kind: "route",
			url: win.location.href,
		});
	};
	win.addEventListener("popstate", onRoute);
	const originalPush = win.history.pushState.bind(win.history);
	win.history.pushState = (...args: Parameters<History["pushState"]>) => {
		const result = originalPush(...args);
		onRoute();
		return result;
	};

	return () => {
		win.document.removeEventListener("click", onClick, true);
		win.removeEventListener("popstate", onRoute);
		win.history.pushState = originalPush;
	};
}
