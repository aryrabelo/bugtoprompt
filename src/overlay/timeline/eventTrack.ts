/**
 * The in-page event track: timestamped clicks, route changes, and manual marks,
 * relative to record-start. Clicks resolve the nearest interactive ancestor and
 * record its selector (+ snapshot ref when the session can map it). Route changes
 * cover TanStack Router (which drives `history.pushState`) and the standalone
 * `history`/`popstate` path, so this works inside any host application and on any page.
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
	/** Fired after `onEvent` for an accepted `kind:"click"` event, carrying the
	 *  viewport CSS coords to crop a screenshot around: the mouseup point for
	 *  pointer clicks, the clicked element's bounding-box center for keyboard
	 *  activation. Not fired for select/route/mark. */
	onPageClick?: (event: CaptureEvent, point: { x: number; y: number }) => void;
	win?: Window;
}

/** Install the listeners; returns a cleanup that fully unwinds them (including
 *  the `history.pushState` monkeypatch). */
export function installEventTrack(opts: EventTrackOptions): () => void {
	const win = opts.win ?? window;

	/** Max selected-text length kept per event — bounds a giant highlight. */
	const MAX_SELECTED = 500;
	// The mouse-down "placeholder": where/when an interaction began. Resolved on
	// mouse-up into a `click` or (if text was highlighted) a `select` event,
	// anchored at the down time so it aligns with what the user was narrating.
	let downMs = 0;
	let downTarget: Element | null = null;

	const emit = (
		target: Element,
		tMs: number,
		kind: "click" | "select",
		extra?: { selectedText?: string; point?: { x: number; y: number } },
	): void => {
		// Never record interactions with the overlay's own UI. With the Shadow
		// DOM mount, events from inside the overlay retarget to the shadow host
		// element, so match the host marker as well.
		if (target.closest?.("[data-bugtoprompt], [data-bugtoprompt-host]")) return;
		const el = target.closest?.(INTERACTIVE) ?? target;
		const ref = opts.resolveRef?.(el);
		const name = accessibleName(el);
		const role = interactiveRole(el);
		const event: CaptureEvent = {
			tMs,
			kind,
			selector: cssSelector(el),
			...(name ? { elementName: name } : {}),
			...(role ? { elementRole: role } : {}),
			...(ref ? { elementRef: ref } : {}),
			...(extra?.selectedText ? { selectedText: extra.selectedText } : {}),
		};
		opts.onEvent(event);
		if (kind === "click" && opts.onPageClick) {
			// Pointer clicks pass a mouseup point; keyboard activation falls back to
			// the element's bounding-box center so the crop still frames the target.
			let point = extra?.point;
			if (!point) {
				const rect = el.getBoundingClientRect?.();
				if (rect) {
					point = {
						x: rect.left + rect.width / 2,
						y: rect.top + rect.height / 2,
					};
				}
			}
			if (point) opts.onPageClick(event, point);
		}
	};

	const onMouseDown = (ev: Event): void => {
		const target = ev.target as Element | null;
		if (target?.nodeType !== 1) return;
		downMs = opts.elapsedMs();
		downTarget = target;
	};

	const onMouseUp = (ev: Event): void => {
		const target = (ev.target as Element | null) ?? downTarget;
		// Anchor at the placeholder (down) time when we have it.
		const tMs = downTarget ? downMs : opts.elapsedMs();
		downTarget = null;
		if (target?.nodeType !== 1) return;
		const selected = (win.getSelection?.()?.toString() ?? "").trim();
		if (selected) {
			emit(target, tMs, "select", {
				selectedText: selected.slice(0, MAX_SELECTED),
			});
		} else if ((ev as MouseEvent).button === 0) {
			// Only primary-button releases count as clicks; right/middle releases
			// must not inflate clickCount or screenshot ordinals.
			const mev = ev as MouseEvent;
			if (mev.button === 0) {
				emit(target, tMs, "click", {
					point: { x: mev.clientX, y: mev.clientY },
				});
			}
		}
	};
	// `mousedown`/`mouseup` cover mouse clicks AND drag-selections; a bare
	// keyboard activation fires `click` with detail 0 and no mouse events.
	const onClick = (ev: Event): void => {
		if ((ev as MouseEvent).detail !== 0) return; // mouse handled by mouseup
		const target = ev.target as Element | null;
		if (target?.nodeType !== 1) return;
		emit(target, opts.elapsedMs(), "click");
	};
	win.document.addEventListener("mousedown", onMouseDown, true);
	win.document.addEventListener("mouseup", onMouseUp, true);
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
	const originalReplace = win.history.replaceState.bind(win.history);
	win.history.replaceState = (...args: Parameters<History["replaceState"]>) => {
		const result = originalReplace(...args);
		onRoute();
		return result;
	};

	return () => {
		win.document.removeEventListener("mousedown", onMouseDown, true);
		win.document.removeEventListener("mouseup", onMouseUp, true);
		win.document.removeEventListener("click", onClick, true);
		win.removeEventListener("popstate", onRoute);
		win.history.pushState = originalPush;
		win.history.replaceState = originalReplace;
	};
}
