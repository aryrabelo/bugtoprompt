/**
 * Assemble the in-session state into a validated CaptureArtifact — the contract
 * handed to the sidecar (and, via it, to the GitHub issue renderer).
 */
import {
	ARTIFACT_VERSION,
	type CaptureArtifact,
	type CaptureEvent,
	type CaptureSnapshot,
	type TranscriptSegment,
} from "../../schema";

export interface SessionData {
	sessionId: string;
	projectId?: string;
	workspaceId?: string;
	branch?: string;
	pageUrl: string;
	startedAt: number;
	durationMs: number;
	audio: { ref: string; mimeType: string; bytes: number };
	transcript: TranscriptSegment[];
	events: CaptureEvent[];
	snapshots: CaptureSnapshot[];
	transcriptionMode: "streaming" | "batch-fallback";
}

export function assembleArtifact(data: SessionData): CaptureArtifact {
	return {
		version: ARTIFACT_VERSION,
		sessionId: data.sessionId,
		...(data.projectId ? { projectId: data.projectId } : {}),
		...(data.workspaceId ? { workspaceId: data.workspaceId } : {}),
		...(data.branch ? { branch: data.branch } : {}),
		pageUrl: data.pageUrl,
		userAgent:
			typeof navigator !== "undefined" ? navigator.userAgent : "unknown",
		startedAt: data.startedAt,
		durationMs: data.durationMs,
		audio: data.audio,
		transcript: data.transcript,
		events: data.events,
		snapshots: data.snapshots,
		transcriptionMode: data.transcriptionMode,
	};
}
