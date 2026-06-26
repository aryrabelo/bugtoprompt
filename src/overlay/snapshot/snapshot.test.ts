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

	test("password input value NEVER leaks into the snapshot (C1 security fix)", () => {
		document.body.innerHTML = `<input type="password" aria-label="Password" />`;
		const input = document.querySelector("input") as HTMLInputElement;
		input.value = "hunter2"; // simulate user typing (not just the attribute)
		const els = buildInteractiveSnapshot(document.body, visibleAll);
		expect(els).toHaveLength(1);
		const serialized = JSON.stringify(els);
		expect(serialized).not.toContain("hunter2");
		expect(els[0]?.name).toBe("Password"); // name comes from aria-label, not .value
	});

	test("text-entry inputs never expose .value; button-like inputs may", () => {
		document.body.innerHTML = `
			<input type="text" placeholder="Username" />
			<input type="email" aria-label="Email" />
			<input type="password" />
			<input type="submit" />
			<input type="reset" />
		`;
		const [txtEl, , pwdEl, submitEl, resetEl] = Array.from(
			document.querySelectorAll("input"),
		) as HTMLInputElement[];
		txtEl.value = "typed-text";
		pwdEl.value = "s3cret";
		(submitEl as HTMLInputElement).value = "Send It";
		(resetEl as HTMLInputElement).value = "Clear";
		const els = buildInteractiveSnapshot(document.body, visibleAll);
		const serialized = JSON.stringify(els);
		// text-entry values must not appear
		expect(serialized).not.toContain("typed-text");
		expect(serialized).not.toContain("s3cret");
		// button-value IS the visible label — must appear
		expect(serialized).toContain("Send It");
		expect(serialized).toContain("Clear");
		// placeholder is a safe name source
		expect(
			els.find((e) => e.role === "textbox" && e.name === "Username"),
		).toBeTruthy();
	});
});

describe("cssSelector", () => {
	test("uses a unique #id", () => {
		document.body.innerHTML = `<button id="go">Go</button>`;
		const el = document.querySelector("#go") as Element;
		expect(cssSelector(el)).toBe("#go");
	});

	test("prefers data-testid when present", () => {
		document.body.innerHTML = `<div><button data-testid="submit-btn">Save</button></div>`;
		const el = document.querySelector("button") as Element;
		expect(cssSelector(el)).toBe('[data-testid="submit-btn"]');
	});

	test("a single stable attribute beats an nth-of-type path", () => {
		document.body.innerHTML = `
			<div>
				<button data-slot="trigger">A</button>
				<button data-slot="content">B</button>
			</div>
		`;
		const trigger = document.querySelector("button") as Element;
		expect(cssSelector(trigger)).toBe('button[data-slot="trigger"]');
	});

	test("a data-slot/data-variant combo beats nth-of-type when neither attr is unique alone", () => {
		// Badge-style: same slot repeated, same variant repeated, but the pair
		// uniquely identifies the element — must win over div > span:nth-of-type(1).
		document.body.innerHTML = `
			<div>
				<span data-slot="badge" data-variant="info">A</span>
				<span data-slot="badge" data-variant="warn">B</span>
				<span data-slot="chip" data-variant="info">C</span>
			</div>
		`;
		const badgeInfo = document.querySelector("span") as Element;
		// Neither single attribute is unique in the document…
		expect(document.querySelectorAll('[data-slot="badge"]').length).toBe(2);
		expect(document.querySelectorAll('[data-variant="info"]').length).toBe(2);
		// …so the combination is chosen, not nth-of-type.
		expect(cssSelector(badgeInfo)).toBe(
			'span[data-slot="badge"][data-variant="info"]',
		);
	});

	test("uses a semantic class but ignores utility/Tailwind tokens", () => {
		document.body.innerHTML = `
			<div>
				<button class="inline-flex items-center px-2 toolbar-save">A</button>
				<button class="inline-flex items-center px-2">B</button>
			</div>
		`;
		const save = document.querySelector("button") as Element;
		expect(cssSelector(save)).toBe("button.toolbar-save");
	});

	test("anchors to the nearest stable (non-id) ancestor before nth-of-type", () => {
		document.body.innerHTML = `
			<section data-testid="panel">
				<div><button>A</button><button>B</button></div>
			</section>
			<section><div><button>C</button></div></section>
		`;
		const second = document.querySelectorAll(
			'[data-testid="panel"] button',
		)[1] as Element;
		expect(cssSelector(second)).toBe(
			'[data-testid="panel"] > div > button:nth-of-type(2)',
		);
	});

	test("falls back to an nth-of-type path under the nearest id (last resort)", () => {
		document.body.innerHTML = `
			<ul id="list"><li><button>A</button></li><li><button>B</button></li></ul>
		`;
		const second = document.querySelectorAll("#list button")[1] as Element;
		expect(cssSelector(second)).toBe("#list > li:nth-of-type(2) > button");
	});

	test("falls back to nth-of-type when only utility classes are present", () => {
		document.body.innerHTML = `
			<div id="bar">
				<button class="inline-flex px-2">A</button>
				<button class="inline-flex px-2">B</button>
			</div>
		`;
		const second = document.querySelectorAll("#bar button")[1] as Element;
		expect(cssSelector(second)).toBe("#bar > button:nth-of-type(2)");
	});
});
