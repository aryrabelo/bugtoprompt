/**
 * Render a CaptureArtifact into an AI-ready prompt in issue format (title +
 * body). The body is a synced "caption": transcript segments and action events
 * interleaved on one `mm:ss` timeline, plus a SMALL machine block listing only
 * the elements that were actually clicked (name + role + selector). Full
 * snapshots stay on disk in `artifact.json` — never in the prompt — and the
 * body is clamped under GitHub's 65536-char limit. Every free-text field is
 * masked through `redactSecrets` before it leaves the machine. Pure — no I/O.
 */

import type {
	CaptureArtifact,
	CaptureEvent,
	InteractiveElement,
} from "../schema";

// ---------------------------------------------------------------------------
// Secret redaction (in-package)
// ---------------------------------------------------------------------------

/** A token-bearing key (matches `GITHUB_TOKEN`, `apiKey`, `db_password`, …). */
const SECRET_KEY =
	/(?:[A-Za-z0-9_-]*(?:token|secret|password|passwd|api[_-]?key|apikey|auth|cookie|credential|access[_-]?key|private[_-]?key|session[_-]?id)[A-Za-z0-9_-]*)/i;

/** `KEY=value` / `KEY: value` / `"key": "value"` where the key looks secret. */
const KEY_VALUE = new RegExp(
	`(${SECRET_KEY.source})(["']?\\s*[:=]\\s*["']?)([^\\s"',;]{3,})(["']?)`,
	"gi",
);

/** Known credential token shapes (provider keys, PATs). */
const TOKEN_SHAPES =
	/\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|gh[ousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|glpat-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|AIza[A-Za-z0-9_-]{20,})\b/g;

/** `Bearer <token>` / `Basic <token>` authorization values. */
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;

/** A JWT (`header.payload.signature`, all base64url). */
const JWT = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g;

const MASK = "[redacted]";

/**
 * Mask credential-looking substrings in free text before it is sent to a model
 * or written into a PR body. Idempotent: redacting already-redacted text is a
 * no-op (the mask contains no secret shape).
 */
function redactSecrets(text: string): string {
	if (!text) return text;
	return text
		.replace(JWT, MASK)
		.replace(BEARER, (_m, scheme) => `${scheme} ${MASK}`)
		.replace(TOKEN_SHAPES, MASK)
		.replace(KEY_VALUE, (m, key, sep, value, closeQuote) =>
			/^(bearer|basic)$/i.test(value) ? m : `${key}${sep}${MASK}${closeQuote}`,
		);
}

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------

/** `mm:ss` for a millisecond offset from record-start. */
function clock(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const m = Math.floor(total / 60);
	const s = total % 60;
	return `${m}:${s.toString().padStart(2, "0")}`;
}

/** The url path (host stripped) for a fallback title. */
function pathOf(url: string): string {
	try {
		return new URL(url).pathname || url;
	} catch {
		return url;
	}
}

/** ref → display label, built from every snapshot's interactive elements. */
function elementLabels(artifact: CaptureArtifact): Map<string, string> {
	const map = new Map<string, string>();
	for (const snap of artifact.snapshots) {
		for (const el of snap.interactiveElements) {
			const name = el.name.trim() || el.role;
			map.set(el.ref, `<${name}> [ref=${el.ref}]`);
		}
	}
	return map;
}

/** GitHub rejects issue bodies over 65536 chars; clamp with headroom. */
const BODY_MAX = 60_000;

/** Only the elements the user actually clicked — the minimal machine context a
 *  downstream agent needs (full snapshots stay on disk in `artifact.json`).
 *  Deduped by selector; name/role prefer the click-time capture, falling back to
 *  the nearest snapshot's record. */
function clickedElements(
	artifact: CaptureArtifact,
): Array<Pick<InteractiveElement, "role" | "name" | "selector">> {
	const bySelector = new Map<string, InteractiveElement>();
	for (const snap of artifact.snapshots) {
		for (const el of snap.interactiveElements) bySelector.set(el.selector, el);
	}
	const out = new Map<
		string,
		Pick<InteractiveElement, "role" | "name" | "selector">
	>();
	for (const ev of artifact.events) {
		if (ev.kind !== "click" || !ev.selector) continue;
		const snap = bySelector.get(ev.selector);
		out.set(ev.selector, {
			role: ev.elementRole ?? snap?.role ?? "",
			name: ev.elementName ?? snap?.name ?? "",
			selector: ev.selector,
		});
	}
	return [...out.values()];
}

type TimelineRow = { tMs: number; line: string };

function eventRow(ev: CaptureEvent, labels: Map<string, string>): TimelineRow {
	if (ev.kind === "click") {
		const own = ev.elementName?.trim()
			? `<${ev.elementName.trim()}>${ev.elementRole ? ` (${ev.elementRole})` : ""}`
			: undefined;
		const label =
			own ?? (ev.elementRef ? labels.get(ev.elementRef) : undefined);
		const target = label ?? (ev.selector ? `\`${ev.selector}\`` : "(element)");
		return { tMs: ev.tMs, line: `🖱 click ${target}` };
	}
	if (ev.kind === "route") {
		return { tMs: ev.tMs, line: `🧭 route ${ev.url ?? ""}`.trimEnd() };
	}
	if (ev.kind === "select") {
		return { tMs: ev.tMs, line: `✂️ selected "${ev.selectedText ?? ""}"` };
	}
	return { tMs: ev.tMs, line: "🚩 mark" };
}

/** The synced caption block (transcript + events, sorted by time). */
function caption(artifact: CaptureArtifact): string {
	const labels = elementLabels(artifact);
	const rows: TimelineRow[] = [
		...artifact.transcript.map((seg) => ({
			tMs: seg.tStartMs,
			line: `🗣 "${seg.text}"`,
		})),
		...artifact.events.map((ev) => eventRow(ev, labels)),
	].sort((a, b) => a.tMs - b.tMs);
	return rows.map((r) => `${clock(r.tMs)}  ${r.line}`).join("\n");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** The idempotency marker prefix embedded in the prompt body. */
export const CAPTURE_MARKER_PREFIX = "bugtoprompt-capture-id:";

export interface RenderOptions {
	/** screenshotRef → public URL; when present a snapshot renders as an inline
	 *  image. v1 has no hosting (a future paid tier covers upload), so this is
	 *  normally empty. */
	screenshotUrls?: Record<string, string>;
	/** Absolute dir the artifact + screenshots were saved to. v1 leaves images on
	 *  disk and references each by its FULL local path in the prompt body. */
	artifactDir?: string;
}

/** The prompt title: the first non-empty transcript line, else a page fallback. */
export function promptTitle(artifact: CaptureArtifact): string {
	const first = artifact.transcript.find((s) => s.text.trim())?.text.trim();
	const base = first ?? `Bug capture on ${pathOf(artifact.pageUrl)}`;
	const trimmed = base.length > 72 ? `${base.slice(0, 71)}…` : base;
	return redactSecrets(trimmed);
}

/** The full prompt body in issue format. Redaction is applied to the whole
 *  assembled string — masks only credential-shaped substrings, leaving the
 *  structure (and the marker) intact. */
export function renderPrompt(
	artifact: CaptureArtifact,
	opts?: RenderOptions,
): string {
	const captured = new Date(artifact.startedAt).toISOString();
	const seconds = (artifact.durationMs / 1000).toFixed(1);
	const header = [
		`**Page:** ${artifact.pageUrl}`,
		artifact.branch ? `**Branch:** ${artifact.branch}` : undefined,
		`**Captured:** ${captured} · ${seconds}s`,
	]
		.filter(Boolean)
		.join("\n");

	const screenshots = artifact.snapshots
		.map((snap) => {
			const at = clock(snap.tMs);
			if (!snap.screenshotRef) {
				return `- snap @ ${at} — interactive snapshot only`;
			}
			const url = opts?.screenshotUrls?.[snap.screenshotRef];
			if (url) return `![snap @ ${at}](${url})`;
			const path = opts?.artifactDir
				? `${opts.artifactDir}/${snap.screenshotRef}`
				: snap.screenshotRef;
			return `- snap @ ${at} — \`${path}\``;
		})
		.join("\n");

	const clicked = clickedElements(artifact);
	const machine = clicked.length
		? [
				"<details>",
				"<summary>Clicked elements (machine-readable)</summary>",
				"",
				"```json",
				JSON.stringify(clicked, null, 2),
				"```",
				"</details>",
			].join("\n")
		: undefined;
	const artifactNote = opts?.artifactDir
		? `**Full artifact:** \`${opts.artifactDir}/artifact.json\``
		: undefined;

	const assemble = (captionBlock: string, withMachine: boolean): string =>
		[
			header,
			"",
			"## Caption",
			"",
			"```",
			captionBlock,
			"```",
			"",
			"### Screenshots",
			"",
			screenshots || "_none captured_",
			...(artifactNote ? ["", artifactNote] : []),
			...(withMachine && machine ? ["", machine] : []),
			"",
			`${CAPTURE_MARKER_PREFIX} ${artifact.sessionId}`,
		].join("\n");

	const cap = caption(artifact);
	let body = assemble(cap, true);
	if (body.length > BODY_MAX) body = assemble(cap, false);
	if (body.length > BODY_MAX) {
		const keep = Math.max(0, BODY_MAX - assemble("", false).length - 32);
		body = assemble(`${cap.slice(0, keep)}\n… (caption truncated)`, false);
	}
	return redactSecrets(body);
}
