/**
 * Build an interactive-elements snapshot in the shape `agent-browser snapshot -i`
 * emits — each interactive element with its role, accessible name, a stable `eN`
 * ref (deterministic DOM order), a CSS selector, and its bounding box. The role +
 * accessible-name priority mirror ARIA closely enough that a downstream agent
 * re-running real agent-browser on the same page can re-align refs by role+name.
 *
 * Visibility + rect are injectable so the walk is unit-testable under a layout-
 * less DOM (happy-dom); the defaults read real layout in the browser.
 */
import type { InteractiveElement } from "../../schema";
import { cssSelector } from "./selector";

/** Explicit ARIA roles we treat as interactive (agent-browser's `-i` set). */
const INTERACTIVE_ROLES: Record<string, true> = {
	button: true,
	link: true,
	checkbox: true,
	radio: true,
	switch: true,
	tab: true,
	menuitem: true,
	menuitemcheckbox: true,
	menuitemradio: true,
	option: true,
	textbox: true,
	combobox: true,
	searchbox: true,
	slider: true,
	spinbutton: true,
};

/** The implicit ARIA role from the tag (+ input type), or null. */
function implicitRole(el: Element): string | null {
	const tag = el.tagName.toLowerCase();
	if (tag === "a") return el.hasAttribute("href") ? "link" : null;
	if (tag === "button") return "button";
	if (tag === "summary") return "button";
	if (tag === "select") return "combobox";
	if (tag === "textarea") return "textbox";
	if (tag === "input") {
		const type = (el.getAttribute("type") ?? "text").toLowerCase();
		if (type === "hidden") return null;
		if (type === "checkbox") return "checkbox";
		if (type === "radio") return "radio";
		if (type === "range") return "slider";
		if (type === "search") return "searchbox";
		if (["button", "submit", "reset", "image"].includes(type)) return "button";
		return "textbox";
	}
	return null;
}

/** The interactive role to record, or null when the element isn't interactive. */
export function interactiveRole(el: Element): string | null {
	const explicit = el.getAttribute("role");
	if (explicit) {
		if (INTERACTIVE_ROLES[explicit]) return explicit;
		return implicitRole(el);
	}
	const implicit = implicitRole(el);
	if (implicit) return implicit;
	const ce = el.getAttribute("contenteditable");
	if (ce !== null && ce !== "false") return "textbox";
	const tabindex = el.getAttribute("tabindex");
	if (tabindex !== null && Number(tabindex) >= 0) return "generic";
	return null;
}

function collapse(text: string): string {
	return text.replace(/\s+/g, " ").trim().slice(0, 120);
}

/** The accessible name, ARIA priority simplified to the high-signal sources. */
export function accessibleName(el: Element): string {
	const doc = el.ownerDocument ?? document;
	const labelledby = el.getAttribute("aria-labelledby");
	if (labelledby) {
		const text = labelledby
			.split(/\s+/)
			.map((id) => doc.getElementById(id)?.textContent ?? "")
			.join(" ")
			.trim();
		if (text) return collapse(text);
	}
	const ariaLabel = el.getAttribute("aria-label");
	if (ariaLabel?.trim()) return collapse(ariaLabel);
	if (el.id) {
		const labelFor = doc.querySelector(
			`label[for="${el.id.replace(/(["\\])/g, "\\$1")}"]`,
		);
		if (labelFor?.textContent?.trim()) return collapse(labelFor.textContent);
	}
	const wrapLabel = el.closest?.("label");
	if (wrapLabel?.textContent?.trim()) return collapse(wrapLabel.textContent);
	const placeholder = el.getAttribute("placeholder");
	if (placeholder?.trim()) return collapse(placeholder);
	const alt = el.querySelector?.("img[alt]")?.getAttribute("alt");
	if (alt?.trim()) return collapse(alt);
	const title = el.getAttribute("title");
	if (title?.trim()) return collapse(title);
	if (el.tagName === "INPUT") {
		const value = (el as HTMLInputElement).value;
		if (value?.trim()) return collapse(value);
	}
	if (el.textContent?.trim()) return collapse(el.textContent);
	return "";
}

export interface SnapshotDeps {
	/** Bounding box (viewport-relative). Defaults to `getBoundingClientRect`. */
	rectOf?: (el: Element) => InteractiveElement["rect"];
	/** Whether to include the element. Defaults to a display/visibility/rect check. */
	isVisible?: (el: Element) => boolean;
}

function defaultRect(el: Element): InteractiveElement["rect"] {
	const r = el.getBoundingClientRect();
	return { x: r.x, y: r.y, width: r.width, height: r.height };
}

function defaultIsVisible(el: Element): boolean {
	if (el.hasAttribute("hidden")) return false;
	if (el.getAttribute("aria-hidden") === "true") return false;
	const win = el.ownerDocument?.defaultView ?? window;
	const style = win.getComputedStyle(el);
	if (style.display === "none" || style.visibility === "hidden") return false;
	const r = el.getBoundingClientRect();
	return r.width > 0 || r.height > 0;
}

const CANDIDATE_SELECTOR =
	"a[href], button, input, select, textarea, summary, [role], [tabindex], [contenteditable]";

/**
 * Walk `root` in DOM order, returning every interactive element as an
 * agent-browser-shaped record. Refs are assigned `e1, e2, …` in walk order.
 */
export function buildInteractiveSnapshot(
	root: Document | Element = document,
	deps: SnapshotDeps = {},
): InteractiveElement[] {
	const isVisible = deps.isVisible ?? defaultIsVisible;
	const rectOf = deps.rectOf ?? defaultRect;
	const out: InteractiveElement[] = [];
	let n = 0;
	for (const el of Array.from(root.querySelectorAll(CANDIDATE_SELECTOR))) {
		const role = interactiveRole(el);
		if (!role) continue;
		if (!isVisible(el)) continue;
		n += 1;
		out.push({
			ref: `e${n}`,
			role,
			name: accessibleName(el),
			selector: cssSelector(el),
			rect: rectOf(el),
		});
	}
	return out;
}

export interface InteractiveSnapshot {
	viewport: { width: number; height: number; scrollX: number; scrollY: number };
	interactiveElements: InteractiveElement[];
}

/** Capture the live page: the interactive snapshot + the current viewport. */
export function captureInteractiveSnapshot(
	win: Window = window,
	deps: SnapshotDeps = {},
): InteractiveSnapshot {
	return {
		viewport: {
			width: win.innerWidth,
			height: win.innerHeight,
			scrollX: win.scrollX,
			scrollY: win.scrollY,
		},
		interactiveElements: buildInteractiveSnapshot(win.document, deps),
	};
}
