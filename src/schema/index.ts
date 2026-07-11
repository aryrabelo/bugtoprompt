/**
 * CaptureArtifact schema — the single shared contract for bugtoprompt (voice-
 * annotated bug capture). Used by both the in-page overlay that records voice +
 * clicks + interactive DOM snapshots and any backend that renders it. Pure zod +
 * inferred types, ZERO runtime deps beyond zod.
 *
 * Timestamps inside a session (`tMs`, `tStartMs`, `tEndMs`) are milliseconds
 * relative to record-start (t=0); `startedAt` is the only wall-clock epoch.
 */
import { z } from "zod";

/** One interactive element, in the shape `agent-browser snapshot -i` emits
 *  (role + accessible name + a stable `eN` ref) so a downstream agent re-running
 *  real agent-browser can re-align refs by role+name. */
export const interactiveElementSchema = z.object({
	/** Deterministic DOM-walk ref: `e1`, `e2`, … (the alignment hint). */
	ref: z.string(),
	/** Explicit `role` attr, else the implicit ARIA role from the tag. */
	role: z.string(),
	/** Accessible name (aria-labelledby → aria-label → label → … → textContent). */
	name: z.string(),
	/** Stable CSS selector for re-querying the element. */
	selector: z.string(),
	/** Viewport-relative bounding box at capture time. */
	rect: z.object({
		x: z.number(),
		y: z.number(),
		width: z.number(),
		height: z.number(),
	}),
});
export type InteractiveElement = z.infer<typeof interactiveElementSchema>;

/** One on-shortcut capture: the interactive snapshot at that instant, plus a
 *  best-effort screenshot. The interactive snapshot is always recorded; the
 *  screenshot is absent (both fields undefined) when screen capture was denied.
 *  `screenshotMethod` records fidelity (real pixels vs DOM raster). */
export const captureSnapshotSchema = z.object({
	tMs: z.number(),
	screenshotRef: z.string().optional(),
	screenshotMethod: z.enum(["getDisplayMedia", "html2canvas"]).optional(),
	viewport: z.object({
		width: z.number(),
		height: z.number(),
		scrollX: z.number(),
		scrollY: z.number(),
	}),
	interactiveElements: z.array(interactiveElementSchema),
});
export type CaptureSnapshot = z.infer<typeof captureSnapshotSchema>;

/** One transcript segment with its time span; `edited` when the user corrected
 *  the live caption text before submit. */
export const transcriptSegmentSchema = z.object({
	tStartMs: z.number(),
	tEndMs: z.number(),
	text: z.string(),
	edited: z.boolean().optional(),
});
export type TranscriptSegment = z.infer<typeof transcriptSegmentSchema>;

/** One timeline event. `click` carries the element it hit; `select` the text the
 *  user highlighted (anchored at mouse-down); `route` a url; `mark` is the
 *  user's manual shortcut beat. */
export const captureEventSchema = z.object({
	tMs: z.number(),
	kind: z.enum(["click", "route", "mark", "select"]),
	/** Snapshot ref of the hit element, when it was in the latest snapshot. */
	elementRef: z.string().optional(),
	/** Accessible name of the clicked element, captured at click time. */
	elementName: z.string().optional(),
	/** ARIA role of the clicked element, captured at click time. */
	elementRole: z.string().optional(),
	selector: z.string().optional(),
	url: z.string().optional(),
	/** Text the user highlighted (kind: "select"), captured on mouse-up. */
	selectedText: z.string().optional(),
	/** 1-based ordinal for a `click` (kind: "click"), matching the numbered
	 *  marker drawn on its screenshot and the review-strip badge. Absent for
	 *  older artifacts and for non-click events. */
	clickNumber: z.number().optional(),
	/** Screenshot ref captured for this click, when a frame was grabbed. Ties the
	 *  timeline entry to its persisted image; absent when the grab was DOM-only. */
	screenshotRef: z.string().optional(),
});
export type CaptureEvent = z.infer<typeof captureEventSchema>;

/** The full capture artifact: audio + synced transcript + action timeline +
 *  interactive snapshots, bound (when known) to a target. */
export const captureArtifactSchema = z.object({
	version: z.literal(1),
	/** uuid minted at record-start; names the artifact dir + idempotency marker. */
	sessionId: z.string(),
	projectId: z.string().optional(),
	workspaceId: z.string().optional(),
	branch: z.string().optional(),
	pageUrl: z.string(),
	userAgent: z.string(),
	/** Wall-clock epoch ms at record-start. */
	startedAt: z.number(),
	durationMs: z.number(),
	audio: z.object({
		ref: z.string(),
		mimeType: z.string(),
		bytes: z.number(),
	}),
	transcript: z.array(transcriptSegmentSchema),
	events: z.array(captureEventSchema),
	snapshots: z.array(captureSnapshotSchema),
	/** How the transcript was produced — live stream, or batch-on-stop fallback. */
	transcriptionMode: z.enum(["streaming", "batch-fallback"]),
});
export type CaptureArtifact = z.infer<typeof captureArtifactSchema>;

/** The current artifact schema version (bump on a breaking shape change). */
export const ARTIFACT_VERSION = 1 as const;
