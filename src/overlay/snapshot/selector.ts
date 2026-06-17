/**
 * Build a reasonably-stable CSS selector for an element, for re-querying it
 * later from a bug report. Selector priority, highest first:
 *   1. a unique `#id`;
 *   2. a unique `[data-testid]`;
 *   3. a unique selector built from the element's own stable attributes —
 *      first a single `tag[attr="…"]`, then small combos `tag[a="…"][b="…"]`;
 *   4. a unique selector from a conservative, semantic-looking class token;
 *   5. an ancestor-anchored path — climb to the nearest ancestor that itself
 *      has a unique stable selector (id / attr / class) and join it to stable
 *      child segments;
 *   6. only when nothing stable distinguishes a node, `tag:nth-of-type(n)`.
 * Pure given an element; reads only the element's own document.
 */

/** Escape a value for use inside `[attr="…"]`. */
function attrEscape(value: string): string {
	return value.replace(/(["\\])/g, "\\$1");
}

function classEscape(value: string): string {
	if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
		return CSS.escape(value);
	}
	return value.replace(/[^A-Za-z0-9_-]/g, "\\$&");
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

/**
 * Stable, semantically meaningful attributes to build selectors from, in
 * descending order of trustworthiness. `data-testid` is handled separately as a
 * top-priority bare selector but is kept here too so combos can use it.
 */
const STABLE_ATTRS = [
	"data-testid",
	"data-test",
	"data-slot",
	"data-variant",
	"data-name",
	"data-action",
	"name",
	"aria-label",
	"title",
	"role",
	"type",
] as const;

/** Tailwind / utility class prefixes whose tokens carry no semantic identity. */
const UTILITY_PREFIX =
	/^(?:p|m|px|py|pt|pb|pl|pr|ps|pe|mx|my|mt|mb|ml|mr|ms|me|w|h|min|max|gap|flex|grid|inline|block|hidden|text|bg|border|rounded|shadow|font|leading|tracking|space|inset|top|bottom|left|right|z|opacity|cursor|select|overflow|absolute|relative|fixed|sticky|static|items|justify|self|order|col|row|basis|grow|shrink|aspect|container|sr|antialiased|truncate|uppercase|lowercase|capitalize|normal|italic|underline|line|ring|outline|divide|backdrop|transition|duration|ease|delay|animate|scale|rotate|skew|translate|transform|origin|object|fill|stroke|whitespace|break|align|float|clear|table|list|appearance|resize|scroll|snap|touch|will|content|gap|invisible|visible|pointer|placeholder|caret|accent|decoration|underline)(?:-|$)/;

/**
 * A class token is "stable" only when it reads like a semantic component name
 * rather than a utility/atomic class. Conservative on purpose: when in doubt we
 * drop the class and let attributes or nth-of-type carry the selector.
 */
function isStableClass(token: string): boolean {
	if (token.length < 3) return false;
	// Tailwind variants / arbitrary values / module hashes use these chars.
	if (/[:/[\]()#%.@!]/.test(token)) return false;
	// A plain identifier (letters first, then word chars / hyphens).
	if (!/^[A-Za-z][\w-]*$/.test(token)) return false;
	if (UTILITY_PREFIX.test(token)) return false;
	// Reject CSS-module-ish hashed suffixes, e.g. `card_a1b2c3` or `btn-x9f2k`.
	if (/[_-][a-z0-9]{6,}$/i.test(token) && /\d/.test(token)) return false;
	return true;
}

/** Present `[attr, value]` pairs for the element, in STABLE_ATTRS order. */
function stableAttrPairs(el: Element): Array<[string, string]> {
	const pairs: Array<[string, string]> = [];
	for (const attr of STABLE_ATTRS) {
		const value = el.getAttribute(attr);
		if (value != null && value !== "") pairs.push([attr, value]);
	}
	return pairs;
}

function attrPart(attr: string, value: string): string {
	return `[${attr}="${attrEscape(value)}"]`;
}

/**
 * A globally-unique selector for `el` built only from element-local signals
 * (id, data-testid, stable attributes, attribute combos, semantic classes), or
 * `null` when none of those single it out in the document.
 */
function uniqueLocal(doc: Document, el: Element): string | null {
	if (el.id) {
		const sel = idSelector(el.id);
		if (isUnique(doc, sel)) return sel;
	}

	const testid = el.getAttribute("data-testid");
	if (testid) {
		const sel = attrPart("data-testid", testid);
		if (isUnique(doc, sel)) return sel;
	}

	const tag = el.tagName.toLowerCase();
	const pairs = stableAttrPairs(el);

	// Single stable attribute, tag-qualified then bare.
	for (const [attr, value] of pairs) {
		const part = attrPart(attr, value);
		if (isUnique(doc, `${tag}${part}`)) return `${tag}${part}`;
		if (isUnique(doc, part)) return part;
	}

	// Small combinations of two stable attributes, in priority order.
	for (let i = 0; i < pairs.length; i++) {
		for (let j = i + 1; j < pairs.length; j++) {
			const a = pairs[i] as [string, string];
			const b = pairs[j] as [string, string];
			const sel = `${tag}${attrPart(a[0], a[1])}${attrPart(b[0], b[1])}`;
			if (isUnique(doc, sel)) return sel;
		}
	}

	// Conservative semantic classes, single then paired with the first attr.
	const classes = Array.from(el.classList).filter(isStableClass);
	for (const cls of classes) {
		const sel = `${tag}.${classEscape(cls)}`;
		if (isUnique(doc, sel)) return sel;
	}
	if (classes.length > 0 && pairs.length > 0) {
		const cls = classes[0] as string;
		const [attr, value] = pairs[0] as [string, string];
		const sel = `${tag}.${classEscape(cls)}${attrPart(attr, value)}`;
		if (isUnique(doc, sel)) return sel;
	}

	return null;
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

/**
 * A qualifier (`[attr="…"]`, `[a][b]`, or `.cls`) that singles `el` out from its
 * same-tag siblings, or `null` when only positional indexing can. Used to build
 * stable path segments without resorting to nth-of-type.
 */
function siblingQualifier(el: Element): string | null {
	const parent = el.parentElement;
	if (!parent) return null;
	const siblings = Array.from(parent.children).filter(
		(c) => c.tagName === el.tagName && c !== el,
	);
	if (siblings.length === 0) return null;

	const pairs = stableAttrPairs(el);
	const distinguishes = (suffix: string): boolean =>
		siblings.every((s) => !s.matches(`${el.tagName.toLowerCase()}${suffix}`));

	for (const [attr, value] of pairs) {
		const part = attrPart(attr, value);
		if (distinguishes(part)) return part;
	}
	for (let i = 0; i < pairs.length; i++) {
		for (let j = i + 1; j < pairs.length; j++) {
			const a = pairs[i] as [string, string];
			const b = pairs[j] as [string, string];
			const part = `${attrPart(a[0], a[1])}${attrPart(b[0], b[1])}`;
			if (distinguishes(part)) return part;
		}
	}
	for (const cls of Array.from(el.classList).filter(isStableClass)) {
		const part = `.${CSS.escape(cls)}`;
		if (distinguishes(part)) return part;
	}
	return null;
}

/** A stable path segment for `el`: tag plus a distinguishing qualifier when one
 *  exists, else `tag:nth-of-type(n)`, else the bare tag. */
function stableSegment(el: Element): string {
	const tag = el.tagName.toLowerCase();
	const qualifier = siblingQualifier(el);
	if (qualifier) return `${tag}${qualifier}`;
	const nth = nthOfType(el);
	return nth > 0 ? `${tag}:nth-of-type(${nth})` : tag;
}

export function cssSelector(el: Element): string {
	const doc = el.ownerDocument ?? document;

	const local = uniqueLocal(doc, el);
	if (local) return local;

	const parts: string[] = [];
	let node: Element | null = el;
	while (node && node.nodeType === 1 && node !== doc.documentElement) {
		const anchor = uniqueLocal(doc, node);
		if (anchor) {
			parts.unshift(anchor);
			break;
		}
		parts.unshift(stableSegment(node));
		node = node.parentElement;
	}
	return parts.join(" > ");
}
