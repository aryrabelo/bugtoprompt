/**
 * Build a reasonably-stable CSS selector for an element, for re-querying it
 * later from a bug report. Prefers a unique `#id` or `[data-testid]`, else walks
 * up to the nearest id-bearing ancestor building a `tag:nth-of-type(n)` path.
 * Pure given an element; reads only the element's own document.
 */

/** Escape a value for use inside `[attr="…"]`. */
function attrEscape(value: string): string {
	return value.replace(/(["\\])/g, "\\$1");
}

/** A selector for an id: bare `#id` when it's a simple token, else `[id="…"]`. */
function idSelector(id: string): string {
	return /^[A-Za-z][\w-]*$/.test(id) ? `#${id}` : `[id="${attrEscape(id)}"]`;
}

function isUnique(doc: Document, selector: string): boolean {
	try {
		return doc.querySelectorAll(selector).length === 1;
	} catch {
		return false;
	}
}

/** Index of `el` among its same-tag siblings (1-based), or 0 when it's the only
 *  one of its tag. */
function nthOfType(el: Element): number {
	const parent = el.parentElement;
	if (!parent) return 0;
	const sameTag = Array.from(parent.children).filter(
		(c) => c.tagName === el.tagName,
	);
	return sameTag.length > 1 ? sameTag.indexOf(el) + 1 : 0;
}

export function cssSelector(el: Element): string {
	const doc = el.ownerDocument ?? document;

	if (el.id) {
		const sel = idSelector(el.id);
		if (isUnique(doc, sel)) return sel;
	}
	const testid = el.getAttribute("data-testid");
	if (testid) {
		const sel = `[data-testid="${attrEscape(testid)}"]`;
		if (isUnique(doc, sel)) return sel;
	}

	const parts: string[] = [];
	let node: Element | null = el;
	while (node && node.nodeType === 1 && node !== doc.documentElement) {
		if (node.id) {
			const sel = idSelector(node.id);
			if (isUnique(doc, sel)) {
				parts.unshift(sel);
				break;
			}
		}
		const nth = nthOfType(node);
		parts.unshift(
			nth > 0
				? `${node.tagName.toLowerCase()}:nth-of-type(${nth})`
				: node.tagName.toLowerCase(),
		);
		node = node.parentElement;
	}
	return parts.join(" > ");
}
