/**
 * The interactive DOM snapshot + selector builders (P1). Run under jsdom
 * (no layout), so visibility is stubbed; the assertions cover the interactive
 * predicate, role mapping, accessible-name priority, ref ordering, and selector
 * stability — the round-trip contract with agent-browser.
 */
import { beforeEach, describe, expect, test } from "vitest";
import {
	buildInteractiveSnapshot,
	captureInteractiveSnapshot,
} from "./buildInteractiveSnapshot";
import { cssSelector } from "./selector";

const visibleAll = { isVisible: () => true };

beforeEach(() => {
	document.body.innerHTML = "";
});

describe("buildInteractiveSnapshot", () => {
	test("keeps interactive elements, skips non-interactive + hidden", () => {
		document.body.innerHTML = `
			<button id="save">Save</button>
			<a href="/x">Learn more</a>
			<input type="text" aria-label="Email" />
			<div role="heading">Title</div>
			<input type="hidden" />
			<span>just text</span>
		`;
		const els = buildInteractiveSnapshot(document.body, visibleAll);
		expect(els.map((e) => [e.ref, e.role, e.name])).toEqual([
			["e1", "button", "Save"],
			["e2", "link", "Learn more"],
			["e3", "textbox", "Email"],
		]);
		expect(els[0]?.selector).toBe("#save");
	});

	test("accessible name priority: aria-label over textContent, label[for]", () => {
		document.body.innerHTML = `
			<button aria-label="Close dialog">x</button>
			<label for="q">Search</label><input id="q" type="search" />
		`;
		const els = buildInteractiveSnapshot(document.body, visibleAll);
		expect(els[0]?.name).toBe("Close dialog");
		expect(els[1]?.role).toBe("searchbox");
		expect(els[1]?.name).toBe("Search");
	});

	test("refs are assigned in DOM order, deterministically", () => {
		document.body.innerHTML =
			"<button>A</button><button>B</button><button>C</button>";
		const first = buildInteractiveSnapshot(document.body, visibleAll);
		const second = buildInteractiveSnapshot(document.body, visibleAll);
		expect(first.map((e) => `${e.ref}:${e.name}`)).toEqual([
			"e1:A",
			"e2:B",
			"e3:C",
		]);
		expect(second).toEqual(first);
	});

	test("captureInteractiveSnapshot includes the viewport", () => {
		document.body.innerHTML = "<button>Go</button>";
		const snap = captureInteractiveSnapshot(window, visibleAll);
		expect(snap.interactiveElements).toHaveLength(1);
		expect(snap.viewport.width).toBe(window.innerWidth);
	});
});

describe("cssSelector", () => {
	test("uses a unique #id", () => {
		document.body.innerHTML = `<button id="go">Go</button>`;
		const el = document.querySelector("#go") as Element;
		expect(cssSelector(el)).toBe("#go");
	});

	test("falls back to an nth-of-type path under the nearest id", () => {
		document.body.innerHTML = `
			<ul id="list"><li><button>A</button></li><li><button>B</button></li></ul>
		`;
		const second = document.querySelectorAll("#list button")[1] as Element;
		expect(cssSelector(second)).toBe("#list > li:nth-of-type(2) > button");
	});

	test("prefers data-testid when present", () => {
		document.body.innerHTML = `<div><button data-testid="submit-btn">Save</button></div>`;
		const el = document.querySelector("button") as Element;
		expect(cssSelector(el)).toBe('[data-testid="submit-btn"]');
	});
});
