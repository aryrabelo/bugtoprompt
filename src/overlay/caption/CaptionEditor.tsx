/**
 * The synced caption view. While recording it shows finalized lines + the live
 * partial; in review the lines become editable so the user can fix names/jargon
 * before the transcript becomes the GitHub issue.
 *
 * New in this revision:
 *  - Internal scrollable container auto-scrolls to the newest segment.
 *  - `partial` is visually distinct from finalized segments (live-dot + italic).
 *  - Optional `streaming` prop drives a health badge (green=live, amber=rec only).
 *    Backward-compatible: callers that omit `streaming` see no badge at all.
 */
import { type ReactElement, useEffect, useRef } from "react";
import type { TranscriptSegment } from "../../schema";

function clock(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, "0")}`;
}

export function CaptionEditor({
	transcript,
	partial,
	editable,
	onEdit,
	streaming,
}: {
	transcript: TranscriptSegment[];
	partial?: string;
	editable?: boolean;
	onEdit?: (index: number, text: string) => void;
	/** Health of the live-stream connection.
	 *  true  → green "live" badge
	 *  false → amber "rec only" badge
	 *  undefined → no badge (backward-compatible default)
	 */
	streaming?: boolean;
}): ReactElement {
	const scrollRef = useRef<HTMLDivElement>(null);

	// Auto-scroll to bottom whenever the transcript grows or the partial changes.
	useEffect(() => {
		const el = scrollRef.current;
		if (el) {
			el.scrollTop = el.scrollHeight;
		}
	}, [transcript.length, partial]);

	return (
		<div className="flex flex-col gap-1">
			{/* Streaming health badge — rendered only when prop is explicitly set */}
			{streaming === true && (
				<div
					role="status"
					className="flex items-center gap-1 text-xs font-medium text-green-500"
					data-testid="streaming-live-badge"
					aria-label="Streaming live"
				>
					<span
						className="inline-block h-2 w-2 rounded-full bg-green-500 animate-pulse"
						aria-hidden="true"
					/>
					live
				</div>
			)}
			{streaming === false && (
				<div
					role="status"
					className="flex items-center gap-1 text-xs font-medium text-amber-500"
					data-testid="streaming-degraded-badge"
					aria-label="Recording only, stream degraded"
				>
					<span
						className="inline-block h-2 w-2 rounded-full bg-amber-500"
						aria-hidden="true"
					/>
					rec only
				</div>
			)}

			{/* Scrollable caption container */}
			<div ref={scrollRef} className="max-h-48 overflow-y-auto space-y-1">
				{transcript.map((seg) => (
					<div
						key={`${seg.tStartMs}-${seg.tEndMs}`}
						className="flex items-baseline gap-2 text-xs"
						data-testid="transcript-segment"
					>
						<span className="shrink-0 text-muted-foreground tabular-nums">
							{clock(seg.tStartMs)}
						</span>
						{editable ? (
							<input
								className="w-full rounded-sm border-input border-b bg-transparent outline-none focus:border-ring"
								value={seg.text}
								onChange={(e) =>
									onEdit?.(transcript.indexOf(seg), e.target.value)
								}
							/>
						) : (
							<span>{seg.text}</span>
						)}
					</div>
				))}

				{/* Live partial — visually distinct: pulsing dot + italic muted text */}
				{partial ? (
					<div
						className="flex items-center gap-1.5 text-xs italic text-muted-foreground"
						data-testid="partial-segment"
						aria-live="polite"
					>
						<span
							className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-current animate-pulse"
							aria-hidden="true"
						/>
						{partial}
					</div>
				) : null}

				{transcript.length === 0 && !partial ? (
					<div className="text-muted-foreground text-xs">
						No transcript yet.
					</div>
				) : null}
			</div>
		</div>
	);
}
