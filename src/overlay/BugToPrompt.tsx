/**
 * bugtoprompt overlay — the floating, Loom-style recorder. Activate it on any
 * page; talk through a bug while clicking; press Mark to pin the element on
 * screen; stop, review the synced caption, and choose an output mode (file an
 * issue, copy the prompt, or download the artifact). Self-portals to <body>,
 * so it never disturbs app layout. Host-agnostic: it only talks to its
 * injected {@link BugToPromptClient}.
 */
import {
	Bug,
	Camera,
	CircleAlert,
	CircleDot,
	ClipboardCopy,
	Download,
	ExternalLink,
	Loader2,
	Mic,
	Square,
	Trash2,
	X,
} from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type BugToPromptClient, createFetchClient } from "../client";
import { promptTitle, renderPrompt, transcriptText } from "../render";
import type { CaptureEvent, TranscriptSegment } from "../schema";
import { Button } from "../ui/button";
import {
	createLocalFallbackClient,
	fetchServerConfig,
	resolveBaseUrl,
} from "./autoConfig";
import { CaptionEditor } from "./caption/CaptionEditor";
import { hasConfiguredKey } from "./key-store";
import { TargetPicker } from "./picker/TargetPicker";
import type { CaptureRecord, OutputMode } from "./session-store";
import {
	addCapture,
	clearShots,
	listCaptures,
	removeCapture,
} from "./session-store";
import { Shutter } from "./snap/Shutter";
import type { ScreenshotMode, SessionBinding } from "./useSession";
import { useSession } from "./useSession";
import { VERSION } from "./version";

/** Idle-panel capability copy per screenshot mode, so the row reflects what the
 *  session will actually do instead of always claiming every click is captured. */
const CAPTURE_ROW_COPY: Record<
	ScreenshotMode,
	{ label: string; desc: string; on: boolean }
> = {
	onClick: {
		label: "Capture every click",
		desc: "Every page click becomes a numbered 400×600 screenshot.",
		on: true,
	},
	perPage: {
		label: "Capture on navigation",
		desc: "Captures a whole-frame screenshot on in-page route changes when screen sharing is available.",
		on: true,
	},
	onMark: {
		label: "Capture on Mark",
		desc: "Screenshots are taken only when you press Mark.",
		on: true,
	},
	off: {
		label: "Screenshots off",
		desc: "DOM timeline & voice only — no screen capture.",
		on: false,
	},
};

function clock(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, "0")}`;
}

function relativeTime(epochMs: number): string {
	const diff = Date.now() - epochMs;
	if (diff < 60_000) return "just now";
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
	return `${Math.floor(diff / 86_400_000)}d ago`;
}

function safeHost(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

/** Trigger a real browser download for `blob`. Callers that provide an
 *  `onDownload` override must bypass this and call `onDownload` themselves. */
function triggerBlobDownload(blob: Blob, filename: string): void {
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	a.click();
	URL.revokeObjectURL(url);
}

/**
 * Inline "paste your AssemblyAI API key" prompt. Shown when live transcription
 * cannot start because no usable streaming credential is configured. The key is
 * handed to `onSave` (session.provideKey), which persists it client-side and
 * attempts to engage live transcription. It is never sent to a first-party
 * server.
 */
function KeyPrompt({
	onSave,
}: {
	onSave: (key: string) => Promise<boolean>;
}): ReactElement {
	const [value, setValue] = useState("");
	const [error, setError] = useState(false);
	const save = async (): Promise<void> => {
		const ok = await onSave(value.trim());
		if (ok) {
			setValue("");
			setError(false);
		} else {
			setError(true);
		}
	};
	return (
		<div className="flex flex-col gap-1.5 rounded-sm border border-border p-2">
			<div className="font-medium">Enable live transcription</div>
			<p className="text-muted-foreground">
				Paste an AssemblyAI API key (Universal-3 Pro). Stored only in this
				browser and sent directly to AssemblyAI — never to a server.
			</p>
			<input
				type="password"
				value={value}
				onChange={(e) => setValue(e.currentTarget.value)}
				placeholder="AssemblyAI API key"
				aria-label="AssemblyAI API key"
				className="rounded-sm border border-border bg-background px-2 py-1 text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
			/>
			{error ? (
				<p role="alert" className="text-destructive">
					That key didn't work — check it and try again.
				</p>
			) : null}
			<div className="flex items-center justify-between gap-2">
				<a
					href="https://www.assemblyai.com/dashboard/api-keys"
					target="_blank"
					rel="noreferrer"
					className="text-primary hover:underline"
				>
					Get a key
				</a>
				<Button size="sm" onClick={() => void save()} disabled={!value.trim()}>
					Save
				</Button>
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// useAutoConfig — zero-config resolution hook
// ---------------------------------------------------------------------------

interface AutoConfigResult {
	client: BugToPromptClient;
	modes: OutputMode[];
	projectId: string | undefined;
	screenshotMode: ScreenshotMode;
	transcriptionProvider: "assemblyai" | "local" | "unconfigured" | undefined;
	hasBackend: boolean;
}

function useAutoConfig({
	clientProp,
	baseUrl,
	modesProp,
	projectIdProp,
	screenshotModeProp,
}: {
	clientProp: BugToPromptClient | undefined;
	baseUrl: string | undefined;
	modesProp: OutputMode[] | undefined;
	projectIdProp: string | undefined;
	screenshotModeProp: ScreenshotMode | undefined;
}): AutoConfigResult {
	const [auto, setAuto] = useState(() => ({
		client: createLocalFallbackClient(),
		modes: modesProp ?? (["clipboard", "download"] as OutputMode[]),
		projectId: projectIdProp,
		screenshotMode: undefined as ScreenshotMode | undefined,
		transcriptionProvider: undefined as
			| "assemblyai"
			| "local"
			| "unconfigured"
			| undefined,
		// Whether the zero-config probe discovered a real backend. When true we
		// never nag for an AssemblyAI key — the server mints streaming tokens.
		backend: false,
	}));

	useEffect(() => {
		if (clientProp !== undefined) return;
		let cancelled = false;
		const run = async (): Promise<void> => {
			const base = resolveBaseUrl(baseUrl);
			const cfg = await fetchServerConfig(base);
			if (cancelled) return;
			// A non-empty base (explicit `baseUrl` prop, `window.__BUGTOPROMPT__`,
			// or the meta tag) is itself proof of a backend — adopt the fetch
			// client and enable issue/token minting even when the optional
			// `GET {base}/bugtoprompt/config` probe doesn't answer. The probe is
			// only required for same-origin zero-config discovery (empty base).
			if (cfg || base) {
				setAuto({
					client: createFetchClient(base),
					modes:
						modesProp ??
						cfg?.modes ??
						(["issue", "clipboard", "download"] as OutputMode[]),
					projectId: projectIdProp ?? cfg?.projectId,
					screenshotMode: cfg?.screenshotMode,
					transcriptionProvider: cfg?.transcriptionProvider,
					backend: true,
				});
			}
		};
		void run();
		return () => {
			cancelled = true;
		};
	}, [clientProp, baseUrl, modesProp, projectIdProp]);

	// Derived effective values — when an explicit client is provided it takes
	// precedence and the classic single-client contract is preserved.
	const client = clientProp ?? auto.client;
	const modes =
		clientProp !== undefined ? (modesProp ?? ["issue"]) : auto.modes;
	const projectId =
		projectIdProp ?? (clientProp !== undefined ? undefined : auto.projectId);

	// screenshotMode priority: explicit prop > window.__BUGTOPROMPT__ > server
	// config > default "onMark". Global/server values arrive as runtime data
	// (only type-cast), so unknown strings are normalized to "onMark" — the
	// same effective behavior useSession applies (any value ≠ "off" captures
	// route/manual marks) — instead of rendering "off" copy for an active mode.
	const globalScreenshotMode =
		typeof window !== "undefined"
			? (window.__BUGTOPROMPT__?.screenshotMode as ScreenshotMode | undefined)
			: undefined;
	const resolvedScreenshotMode =
		screenshotModeProp ??
		globalScreenshotMode ??
		auto.screenshotMode ??
		"onMark";
	// External sources (window.__BUGTOPROMPT__, server config) are untrusted at
	// runtime, so an unknown mode falls back to "onMark" instead of crashing the
	// render when it indexes CAPTURE_ROW_COPY.
	const screenshotMode: ScreenshotMode = Object.hasOwn(
		CAPTURE_ROW_COPY,
		resolvedScreenshotMode,
	)
		? resolvedScreenshotMode
		: "onMark";

	return {
		client,
		modes,
		projectId,
		screenshotMode,
		transcriptionProvider: auto.transcriptionProvider,
		hasBackend: auto.backend,
	};
}

// ---------------------------------------------------------------------------
// CaptureHistoryList — idle-phase capture history
// ---------------------------------------------------------------------------

interface CaptureHistoryListProps {
	captures: CaptureRecord[];
	clipboard: Pick<Clipboard, "writeText"> | undefined;
	modes: OutputMode[];
	projectId: string | undefined;
	client: BugToPromptClient;
	lastFiled: { id: string; url: string } | null;
	onDelete: (id: string) => void;
	onFiledUpdate: (filed: { id: string; url: string }) => void;
	onDownload: (rec: CaptureRecord) => void;
}

function CaptureHistoryList({
	captures,
	clipboard,
	modes,
	projectId,
	client,
	lastFiled,
	onDelete,
	onFiledUpdate,
	onDownload,
}: CaptureHistoryListProps): ReactElement {
	// Track which history-item copy failed so we can surface an inline alert.
	const [copyFailedId, setCopyFailedId] = useState<string | null>(null);

	if (captures.length === 0) {
		return <p className="text-muted-foreground">No captures yet.</p>;
	}

	return (
		<ul className="flex max-h-48 flex-col gap-0.5 overflow-y-auto">
			{captures.map((rec) => (
				<li
					key={rec.id}
					className="flex flex-col gap-0.5 rounded-sm border border-border px-2 py-1"
				>
					<div className="flex items-start justify-between gap-1">
						<span className="truncate font-medium leading-snug">
							{rec.title}
						</span>
						<div className="flex shrink-0 items-center gap-0.5">
							<Button
								variant="ghost"
								size="sm"
								className="size-6 p-0"
								aria-label="Copy"
								onClick={() => {
									const cb = clipboard ?? navigator.clipboard;
									// P0-1: wrap in try/catch; surface failure inline.
									void cb.writeText(rec.prompt).then(
										() => setCopyFailedId(null),
										() => setCopyFailedId(rec.id),
									);
								}}
							>
								<ClipboardCopy className="size-3.5" />
							</Button>
							<Button
								variant="ghost"
								size="sm"
								className="size-6 p-0"
								aria-label="Download"
								onClick={() => onDownload(rec)}
							>
								<Download className="size-3.5" />
							</Button>
							<Button
								variant="ghost"
								size="sm"
								className="size-6 p-0"
								aria-label="Delete"
								onClick={() => {
									void removeCapture(rec.id).then(() => onDelete(rec.id));
								}}
							>
								<Trash2 className="size-3.5" />
							</Button>
							{modes.includes("issue") ? (
								<Button
									variant="ghost"
									size="sm"
									className="size-6 p-0"
									aria-label="File issue"
									onClick={() => {
										if (!projectId) return;
										void client
											.createIssue({
												sessionId: rec.id,
												prompt: rec.prompt,
												// Forward the target captured at record-time so a
												// site-binding's mapped repo is used instead of the
												// server falling back to config.targets[0].
												...(rec.artifact.workspaceId
													? { targetId: rec.artifact.workspaceId }
													: {}),
												...(transcriptText(rec.artifact.transcript)
													? {
															transcriptText: transcriptText(
																rec.artifact.transcript,
															),
														}
													: {}),
											})
											.then((r) => {
												onFiledUpdate({ id: rec.id, url: r.url });
											});
									}}
								>
									<Bug className="size-3.5" />
								</Button>
							) : null}
						</div>
					</div>
					<span className="text-[10px] text-muted-foreground">
						{relativeTime(rec.createdAt)} · {safeHost(rec.pageUrl)}
					</span>
					{copyFailedId === rec.id ? (
						<p role="alert" className="text-[10px] text-destructive">
							Copy failed — check clipboard permissions.
						</p>
					) : null}
					{lastFiled?.id === rec.id ? (
						<a
							href={lastFiled.url}
							target="_blank"
							rel="noreferrer"
							className="flex items-center gap-1 text-[10px] text-primary hover:underline"
						>
							<ExternalLink className="size-3" /> Issue filed
						</a>
					) : null}
				</li>
			))}
		</ul>
	);
}

// ---------------------------------------------------------------------------
// DonePanel — issue successfully filed
// ---------------------------------------------------------------------------

function DonePanel({
	issueUrl,
	onReset,
}: {
	issueUrl: string | undefined;
	onReset: () => void;
}): ReactElement {
	return (
		<>
			<a
				href={issueUrl}
				target="_blank"
				rel="noreferrer"
				className="flex items-center gap-1.5 font-medium text-primary hover:underline"
			>
				<ExternalLink className="size-4" /> Issue filed
			</a>
			<Button size="sm" variant="secondary" onClick={onReset}>
				New capture
			</Button>
		</>
	);
}

// ---------------------------------------------------------------------------
// ErrorPanel — session error
// ---------------------------------------------------------------------------

function ErrorPanel({
	error,
	onReset,
}: {
	error: string | undefined;
	onReset: () => void;
}): ReactElement {
	return (
		<>
			<p role="alert" className="flex items-start gap-1.5 text-destructive">
				<CircleAlert className="size-4 shrink-0" />
				{error}
			</p>
			<Button size="sm" variant="secondary" onClick={onReset}>
				Reset
			</Button>
		</>
	);
}

// ---------------------------------------------------------------------------
// CapabilityRow — one bordered idle-phase capability line (Jam-style row)
// ---------------------------------------------------------------------------

function CapabilityRow({
	icon,
	label,
	status,
	statusTone = "muted",
	children,
}: {
	icon: ReactNode;
	label: string;
	status?: string;
	statusTone?: "muted" | "on" | "off";
	children?: ReactNode;
}): ReactElement {
	const tone =
		statusTone === "on"
			? "text-green-500"
			: statusTone === "off"
				? "text-muted-foreground"
				: "text-muted-foreground";
	return (
		<div className="flex flex-col gap-1.5 rounded-sm border border-border px-2.5 py-2">
			<div className="flex items-center justify-between gap-2">
				<span className="flex items-center gap-1.5 font-medium">
					{icon}
					{label}
				</span>
				{status ? (
					<span className={`text-[10px] ${tone}`}>{status}</span>
				) : null}
			</div>
			{children}
		</div>
	);
}

// ---------------------------------------------------------------------------
// RecordingCard — compact recorder shown while recording (pure/deterministic)
// ---------------------------------------------------------------------------

export interface RecordingCardProps {
	elapsedMs: number;
	streaming: boolean;
	clickCount: number;
	/** Latest grabbed click screenshot, if any (from clickPreviews). */
	latestThumb?: { clickNumber: number; url: string };
	screenshotsUnavailable: boolean;
	transcript: TranscriptSegment[];
	partial: string;
	needsKey: boolean;
	onProvideKey: (key: string) => Promise<boolean>;
	voiceEnabled: boolean;
	onEnableVoice: () => void;
	flashTick: number;
	onMark: () => void;
	onStop: () => void;
}

export function RecordingCard({
	elapsedMs,
	streaming,
	clickCount,
	latestThumb,
	screenshotsUnavailable,
	transcript,
	partial,
	needsKey,
	onProvideKey,
	voiceEnabled,
	onEnableVoice,
	flashTick,
	onMark,
	onStop,
}: RecordingCardProps): ReactElement {
	return (
		<div data-testid="recording-card" className="flex flex-col gap-2.5">
			{/* Elapsed + live status. aria-live announces rec-only → live flips. */}
			<div aria-live="polite" className="flex items-center justify-between">
				<span className="flex items-center gap-1.5 font-medium text-red-500 tabular-nums">
					<CircleDot className="size-4 animate-pulse" /> {clock(elapsedMs)}
				</span>
				<span className="flex items-center gap-1.5 text-muted-foreground">
					<span
						aria-hidden="true"
						className={`inline-block size-1.5 rounded-full ${
							streaming ? "bg-green-500" : "bg-amber-500"
						}`}
					/>
					<span className={streaming ? "text-green-500" : "text-amber-500"}>
						{streaming ? "live" : "rec only"}
					</span>
				</span>
			</div>

			{/* Click count + latest numbered thumbnail. */}
			<div className="flex items-center gap-2.5">
				<span
					key={flashTick}
					data-testid="click-count"
					className={`flex items-center gap-1.5 font-medium tabular-nums${
						flashTick > 0 ? " snap-count-pulse" : ""
					}`}
				>
					<Camera className="size-4" /> {clickCount} click
					{clickCount === 1 ? "" : "s"}
				</span>
				{latestThumb ? (
					<span
						data-testid="latest-thumbnail"
						className="relative ml-auto block w-12 shrink-0 overflow-hidden rounded-sm border border-border"
					>
						<img
							src={latestThumb.url}
							alt={`Latest click ${latestThumb.clickNumber}`}
							className="block aspect-[2/3] w-full object-cover"
						/>
						<span className="absolute top-0.5 left-0.5 rounded-sm bg-foreground px-1 text-[9px] text-background tabular-nums">
							{latestThumb.clickNumber}
						</span>
					</span>
				) : null}
			</div>

			{screenshotsUnavailable ? (
				<p role="status" className="text-[10px] text-amber-500">
					Screenshots unavailable — recording clicks, DOM &amp; voice only.
				</p>
			) : null}

			{needsKey ? <KeyPrompt onSave={onProvideKey} /> : null}

			<div className="max-h-32 overflow-y-auto">
				<CaptionEditor transcript={transcript} partial={partial} />
			</div>

			{/* Two equal actions: Mark + destructive Stop. */}
			<div className="flex gap-2">
				<Button
					size="sm"
					variant="secondary"
					className="flex-1"
					data-testid="mark"
					onClick={onMark}
				>
					<Camera className="size-4" /> Mark
				</Button>
				<Button
					size="sm"
					variant="destructive"
					className="flex-1"
					data-testid="stop"
					onClick={onStop}
				>
					<Square className="size-4" /> Stop
				</Button>
			</div>

			{/* Voice row — cannot accidentally disable an active recording. */}
			<label className="flex cursor-pointer items-center gap-1.5 text-muted-foreground hover:text-foreground">
				<input
					type="checkbox"
					checked={voiceEnabled}
					onChange={() => {
						if (!voiceEnabled) onEnableVoice();
					}}
					disabled={voiceEnabled}
					className="size-3 cursor-pointer accent-primary"
				/>
				<Mic className="size-3" />
				Voice narration {voiceEnabled ? "(on)" : ""}
			</label>
		</div>
	);
}

// ---------------------------------------------------------------------------
// ReviewPanel — expanded review layout (pure/deterministic)
// ---------------------------------------------------------------------------

export interface ReviewPanelProps {
	transcript: TranscriptSegment[];
	events?: CaptureEvent[];
	clickPreviews: Array<{
		clickNumber: number;
		screenshotRef: string;
		url: string;
	}>;
	onEditSegment: (index: number, text: string) => void;
	saveWarning?: string;
	lastAction: "none" | "copied" | "downloaded" | "copy-failed";
	modes: OutputMode[];
	primaryMode: OutputMode;
	fileDisabled: boolean;
	/** Late-binding target picker node (issue mode without a frozen projectId). */
	targetPicker?: ReactNode;
	needTargetHint: boolean;
	onDiscard: () => void;
	onCreateIssue: () => void;
	onCopy: () => void;
	onDownload: () => void;
}

export function ReviewPanel({
	transcript,
	events,
	clickPreviews,
	onEditSegment,
	saveWarning,
	lastAction,
	modes,
	primaryMode,
	fileDisabled,
	targetPicker,
	needTargetHint,
	onDiscard,
	onCreateIssue,
	onCopy,
	onDownload,
}: ReviewPanelProps): ReactElement {
	return (
		<div data-testid="review-panel" className="flex flex-col gap-2.5">
			{/* Ordered numbered click strip — 400×600 scaled thumbnails. */}
			{clickPreviews.length > 0 ? (
				<ol
					data-testid="click-strip"
					className="flex flex-row gap-2 overflow-x-auto pb-1"
				>
					{clickPreviews.map((p) => (
						<li
							key={p.clickNumber}
							data-testid="click-thumbnail"
							className="relative block w-16 shrink-0 overflow-hidden rounded-sm border border-border"
						>
							<img
								src={p.url}
								alt={`Click ${p.clickNumber} screenshot`}
								className="block aspect-[2/3] w-full object-cover"
							/>
							<span className="absolute top-0.5 left-0.5 rounded-sm bg-foreground px-1 text-[9px] text-background tabular-nums">
								{p.clickNumber}
							</span>
						</li>
					))}
				</ol>
			) : (
				<p className="text-[10px] text-muted-foreground">
					No click screenshots captured.
				</p>
			)}

			<div className="max-h-40 overflow-y-auto">
				<CaptionEditor
					transcript={transcript}
					events={events}
					editable
					onEdit={onEditSegment}
				/>
			</div>

			{saveWarning ? (
				<p role="alert" className="text-yellow-500">
					{saveWarning}
				</p>
			) : null}
			{lastAction === "copy-failed" ? (
				<p role="alert" className="text-destructive">
					Failed to copy — check clipboard permissions.
				</p>
			) : lastAction === "copied" ? (
				<p className="text-green-500">Copied to clipboard!</p>
			) : lastAction === "downloaded" ? (
				<p className="text-green-500">Downloaded!</p>
			) : null}

			{targetPicker}
			{needTargetHint ? (
				<p className="text-muted-foreground">
					Select a project to file the issue.
				</p>
			) : null}

			{/* Sticky action footer: Create GitHub issue primary; Copy/Download
			    secondary; Discard low-emphasis destructive. */}
			<div className="sticky bottom-0 flex flex-wrap items-center gap-2 border-border border-t bg-popover pt-2">
				{modes.includes("issue") && (
					<Button
						size="sm"
						variant={primaryMode === "issue" ? "default" : "secondary"}
						disabled={fileDisabled}
						data-testid="create-issue"
						onClick={onCreateIssue}
					>
						<Bug className="size-4" /> Create GitHub issue
					</Button>
				)}
				{modes.includes("clipboard") && (
					<Button
						size="sm"
						variant={primaryMode === "clipboard" ? "default" : "secondary"}
						data-testid="copy"
						onClick={onCopy}
					>
						<ClipboardCopy className="size-4" /> Copy
					</Button>
				)}
				{modes.includes("download") && (
					<Button
						size="sm"
						variant={primaryMode === "download" ? "default" : "secondary"}
						data-testid="download"
						onClick={onDownload}
					>
						<Download className="size-4" /> Download
					</Button>
				)}
				<button
					type="button"
					data-testid="discard"
					onClick={onDiscard}
					className="ml-auto rounded-sm px-1 text-[11px] text-muted-foreground transition-colors hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				>
					Discard
				</button>
			</div>
		</div>
	);
}

// OutputMode is defined in session-store; re-export here for backward compat.
export type { OutputMode };

export interface BugToPromptProps {
	/** The BugToPromptClient implementation. Optional — when omitted the overlay
	 *  auto-resolves a backend from `window.__BUGTOPROMPT__`, a meta tag, or
	 *  falls back to clipboard/download-only mode without a backend. */
	client?: BugToPromptClient;
	/** Explicit base URL for the bugtoprompt backend (overrides auto-detection).
	 *  Only used when `client` is omitted. */
	baseUrl?: string;
	/** The currently-selected project (the issue's target repo is derived from it). */
	projectId?: string;
	/** The open target binding, when one is selected. */
	workspaceId?: string;
	branch?: string;
	/** Which output modes to surface in the review panel.
	 *  Default when `client` is explicit: `['issue']`.
	 *  Default when auto-configured: `['clipboard','download']` (upgraded to server config). */
	modes?: OutputMode[];
	/** The primary action. Defaults to the first entry in `modes`. */
	defaultMode?: OutputMode;
	/** Screenshot strategy for this session. Overrides server config / global hint.
	 *  "perPage" re-prompts on each navigation; "onMark" only on explicit Mark
	 *  (default); "off" captures DOM-only snapshots without screen share. */
	screenshotMode?: ScreenshotMode;
	/** Default state of the pre-record Voice narration toggle (the user can still change it before recording). Default: false — voice is opt-in. */
	autoVoice?: boolean;
	/** Open the capture panel immediately on mount instead of showing only the
	 *  floating launcher. Used by the extension so activation gives instant
	 *  visible feedback. Default: false. */
	defaultOpen?: boolean;
	/** Where the launcher/panel portals render. Defaults to document.body; the
	 *  standalone/extension mount passes a Shadow DOM container so overlay CSS
	 *  never collides with host-page stylesheets (e.g. Tailwind class names). */
	portalTarget?: Element;
	// --- injection points for testability ---
	/** Override the clipboard implementation (default: navigator.clipboard). */
	clipboard?: Pick<Clipboard, "writeText">;
	/** Called instead of the real DOM download trigger. Receives the rendered
	 *  prompt as a Blob (.md) and the artifact JSON as a Blob. */
	onDownload?: (md: Blob, artifactJson: Blob) => void;
}

export function BugToPrompt({
	client: clientProp,
	baseUrl,
	projectId: projectIdProp,
	workspaceId,
	branch,
	modes: modesProp,
	defaultMode,
	screenshotMode: screenshotModeProp,
	autoVoice = false,
	defaultOpen = false,
	portalTarget,
	clipboard,
	onDownload,
}: BugToPromptProps): ReactElement | null {
	const {
		client,
		modes,
		projectId,
		screenshotMode,
		transcriptionProvider,
		hasBackend,
	} = useAutoConfig({
		clientProp,
		baseUrl,
		modesProp,
		projectIdProp,
		screenshotModeProp,
	});

	const [open, setOpen] = useState(defaultOpen);
	const [pickedWs, setPickedWs] = useState<string | undefined>();
	const [pickedBranch, setPickedBranch] = useState<string | undefined>();
	// The binding is FROZEN at record-start: navigating the app (which moves the
	// live selection) while recording must not retarget the capture's target.
	const [frozen, setFrozen] = useState<SessionBinding | undefined>();
	// Inline confirmation for clipboard/download modes; "copy-failed" surfaces on error.
	const [lastAction, setLastAction] = useState<
		"none" | "copied" | "downloaded" | "copy-failed"
	>("none");
	const session = useSession(client, screenshotMode);
	// History state — refreshed on panel open and after each finish.
	const [captures, setCaptures] = useState<CaptureRecord[]>(() =>
		listCaptures(),
	);
	// Transient feedback for "File issue" triggered from the history panel.
	const [lastFiled, setLastFiled] = useState<{
		id: string;
		url: string;
	} | null>(null);
	const [wantVoice, setWantVoice] = useState(autoVoice);
	// P0-2: late target selection during reviewing. The record-start binding is
	// frozen; if it froze without a projectId (config resolved after start), the
	// user can still pick a target here and this overrides the frozen binding.
	const [reviewTarget, setReviewTarget] = useState<
		{ id: string; branch?: string } | undefined
	>();
	// Dedup guard so the issue-done effect only records once per session.
	const lastRecordedRef = useRef<string>("");
	// P1-3: ref for moving focus into the panel when it opens.
	const panelRef = useRef<HTMLDivElement>(null);

	const primaryMode = defaultMode ?? modes[0] ?? "issue";
	const idle = session.phase === "idle";
	const effWorkspaceId = workspaceId ?? pickedWs;
	const effBranch = branch ?? pickedBranch;
	const needsPicker = idle && !workspaceId;
	// Only nag for an AssemblyAI key on standalone, no-backend, no-key installs.
	// A host that injects an explicit `client` (e.g. the host application) is never asked.
	const showIdleKeyPrompt =
		idle && clientProp === undefined && !hasBackend && !hasConfiguredKey();
	// Surface which transcription path is actually active (deferred from #13):
	// "unconfigured"/undefined (fallback client, or config not yet resolved)
	// keeps the base label unchanged rather than implying a path that isn't set.
	const voiceLabel =
		transcriptionProvider === "local"
			? "Live voice transcription (local)"
			: transcriptionProvider === "assemblyai"
				? "Live voice transcription (cloud)"
				: "Live voice transcription";

	const liveBinding: SessionBinding = {
		...(projectId ? { projectId } : {}),
		...(effWorkspaceId ? { workspaceId: effWorkspaceId } : {}),
		...(effBranch ? { branch: effBranch } : {}),
	};
	const binding = !idle && frozen ? frozen : liveBinding;

	// P0-2: when the frozen binding lacks a projectId, build the file target from
	// the resolved projectId as soon as it is available — independent of whether
	// a target was picked. Filing must not stay blocked forever when
	// listTargets() fails/empty (no reviewTarget ever). workspaceId/branch are
	// added only when a target was actually selected. Note: reviewTarget can
	// never be set while projectId is undefined — TargetPicker itself requires
	// a truthy projectId to fetch targets (see useTargetOptions) — so gating on
	// projectId alone (not reviewTarget) loses no reachable case. projectId is
	// config-global (never sent to the server — it only gates the button).
	const reviewBinding: SessionBinding | undefined =
		session.phase === "reviewing" && !binding.projectId && projectId
			? {
					projectId,
					...(reviewTarget?.id ? { workspaceId: reviewTarget.id } : {}),
					...(reviewTarget?.branch ? { branch: reviewTarget.branch } : {}),
				}
			: undefined;
	const fileBinding = reviewBinding ?? binding;

	const discard = (): void => {
		// Reviewing-phase discard: wipe screenshots so no partial history survives.
		if (session.phase === "reviewing" && session.artifact) {
			void clearShots(session.artifact.sessionId);
		}
		setFrozen(undefined);
		setReviewTarget(undefined);
		setLastAction("none");
		setLastFiled(null);
		session.reset();
	};

	/** Build a CaptureRecord from the current artifact and append to history. */
	const recordFinished = (mode: OutputMode): void => {
		const art = session.artifact;
		if (!art) return;
		const final = { ...art, transcript: session.transcript };
		addCapture({
			v: 1,
			id: art.sessionId,
			title: promptTitle(final),
			createdAt: Date.now(),
			pageUrl: final.pageUrl,
			prompt: renderPrompt(final),
			artifact: final,
			mode,
		});
		setCaptures(listCaptures());
	};

	// P0-1: handleClipboard wraps the clipboard write in try/catch and surfaces
	// "copy-failed" on failure instead of silently swallowing the error.
	const handleClipboard = async (): Promise<void> => {
		const artifact = session.artifact;
		if (!artifact) return;
		const final = { ...artifact, transcript: session.transcript };
		const text = renderPrompt(final);
		const cb = clipboard ?? navigator.clipboard;
		try {
			await cb.writeText(text);
			setLastAction("copied");
			recordFinished("clipboard");
		} catch {
			setLastAction("copy-failed");
		}
	};

	// P2-1: handleDownload and handleHistoryDownload share triggerBlobDownload.
	const handleDownload = (): void => {
		const artifact = session.artifact;
		if (!artifact) return;
		const final = { ...artifact, transcript: session.transcript };
		const md = new Blob([renderPrompt(final)], { type: "text/markdown" });
		const json = new Blob([JSON.stringify(final, null, 2)], {
			type: "application/json",
		});
		if (onDownload) {
			onDownload(md, json);
		} else {
			triggerBlobDownload(md, `snap-${final.sessionId}.md`);
			triggerBlobDownload(json, `snap-${final.sessionId}.json`);
		}
		setLastAction("downloaded");
		recordFinished("download");
	};

	/** Download a history record (reuses triggerBlobDownload). */
	const handleHistoryDownload = (rec: CaptureRecord): void => {
		const md = new Blob([rec.prompt], { type: "text/markdown" });
		const json = new Blob([JSON.stringify(rec.artifact, null, 2)], {
			type: "application/json",
		});
		if (onDownload) {
			onDownload(md, json);
		} else {
			triggerBlobDownload(md, `snap-${rec.id}.md`);
			triggerBlobDownload(json, `snap-${rec.id}.json`);
		}
	};

	// Refresh captures when the panel opens.
	useEffect(() => {
		if (open) setCaptures(listCaptures());
	}, [open]);

	// P1-3: move focus into the panel when it opens so keyboard/screen-reader
	// users land on the first interactive element immediately.
	useEffect(() => {
		if (!open || !panelRef.current) return;
		const first = panelRef.current.querySelector<HTMLElement>(
			'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
		);
		first?.focus();
	}, [open]);

	// Record to history when an issue is successfully filed.
	// biome-ignore lint/correctness/useExhaustiveDependencies: recordFinished closes over stable module fns; listCaptures is stable
	useEffect(() => {
		if (
			session.phase !== "done" ||
			!session.issueUrl ||
			!session.artifact ||
			lastRecordedRef.current === session.artifact.sessionId
		)
			return;
		lastRecordedRef.current = session.artifact.sessionId;
		recordFinished("issue");
	}, [session.phase, session.issueUrl, session.artifact, session.transcript]);

	if (typeof document === "undefined") return null;

	const portalHost = portalTarget ?? document.body;

	if (!open) {
		return createPortal(
			<button
				type="button"
				data-bugtoprompt
				onClick={() => setOpen(true)}
				className="fixed right-4 bottom-4 z-[9999] flex items-center gap-1.5 rounded-full bg-foreground px-3 py-2 text-background text-xs shadow-lg transition-colors hover:bg-foreground/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
			>
				<Bug className="size-4" /> BugToPrompt
			</button>,
			portalHost,
		);
	}

	const recording = session.phase === "recording";
	// Idle/recording use a compact 360px panel; review expands to 480px for the
	// click strip. max-w keeps it inside small viewports.
	const panelWidth = session.phase === "reviewing" ? "w-[480px]" : "w-90";
	const latestPreview =
		session.clickPreviews.length > 0
			? session.clickPreviews[session.clickPreviews.length - 1]
			: undefined;

	const portal = createPortal(
		// P1-3: role="dialog" + aria-modal give screen readers the panel's dialog
		// semantics; aria-label names it. Focus is moved to the first child via
		// the useEffect above on every open transition.
		<div
			ref={panelRef}
			role="dialog"
			aria-modal="true"
			aria-label="BugToPrompt"
			data-bugtoprompt
			className={`fixed right-4 bottom-4 z-[9999] flex max-h-[calc(100vh-2rem)] ${panelWidth} max-w-[calc(100vw-2rem)] flex-col gap-3 overflow-y-auto rounded-md border border-border bg-popover p-3 text-popover-foreground text-xs shadow-xl`}
		>
			<div className="flex items-center justify-between">
				<div className="flex items-center gap-1.5 font-medium">
					<Bug className="size-4" /> BugToPrompt
					<span className="font-normal text-muted-foreground">v{VERSION}</span>
				</div>
				<button
					type="button"
					onClick={() => setOpen(false)}
					className="rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					aria-label="Close"
				>
					<X className="size-4" />
				</button>
			</div>

			{modes.includes("issue") ? (
				needsPicker ? (
					<TargetPicker
						client={client}
						projectId={projectId}
						value={effWorkspaceId}
						onChange={(id, b) => {
							setPickedWs(id);
							setPickedBranch(b);
						}}
					/>
				) : (
					<div className="text-muted-foreground">
						Target:{" "}
						<span className="text-foreground">
							{binding.branch ?? binding.workspaceId ?? projectId ?? "none"}
						</span>
					</div>
				)
			) : null}

			{session.phase === "idle" ? (
				<>
					{/* Three bordered capability rows (Jam-style). */}
					<CapabilityRow
						icon={<Camera className="size-3.5" />}
						label={CAPTURE_ROW_COPY[screenshotMode].label}
						status={CAPTURE_ROW_COPY[screenshotMode].on ? "on" : "off"}
						statusTone={CAPTURE_ROW_COPY[screenshotMode].on ? "on" : "off"}
					>
						<p className="text-[10px] text-muted-foreground">
							{CAPTURE_ROW_COPY[screenshotMode].desc}
						</p>
					</CapabilityRow>
					<CapabilityRow
						icon={<Mic className="size-3.5" />}
						label={voiceLabel}
						status={wantVoice ? "on" : "off"}
						statusTone={wantVoice ? "on" : "off"}
					>
						{showIdleKeyPrompt ? (
							<KeyPrompt onSave={(key) => session.provideKey(key)} />
						) : null}
						{/* The voice opt-out stays visible even on a no-key install so an
						    autoVoice default can be turned off before Start (which calls
						    enableVoice() and requests the microphone). */}
						<label className="flex cursor-pointer items-center gap-1.5 text-[10px] text-muted-foreground hover:text-foreground">
							<input
								type="checkbox"
								checked={wantVoice}
								onChange={(e) => setWantVoice(e.currentTarget.checked)}
								className="size-3 cursor-pointer accent-primary"
							/>
							Narrate the bug aloud (optional).
						</label>
					</CapabilityRow>
					<CapabilityRow
						icon={<Bug className="size-3.5" />}
						label="Create GitHub issue"
						status={modes.includes("issue") ? "ready" : "unavailable"}
						statusTone={modes.includes("issue") ? "on" : "off"}
					/>

					{/* Dominant primary action. */}
					<Button
						size="sm"
						className="w-full"
						data-testid="start"
						onClick={() => {
							setFrozen(binding);
							void session.start(binding).then((started) => {
								if (started && wantVoice) void session.enableVoice();
							});
						}}
					>
						<CircleDot className="size-4" /> Start capture
					</Button>

					{/* Capture history behind a disclosure so it never precedes the
					    primary action. */}
					<details data-testid="recent-captures">
						<summary className="cursor-pointer text-muted-foreground hover:text-foreground">
							Recent captures
						</summary>
						<div className="mt-2">
							<CaptureHistoryList
								captures={captures}
								clipboard={clipboard}
								modes={modes}
								projectId={projectId}
								client={client}
								lastFiled={lastFiled}
								onDelete={() => setCaptures(listCaptures())}
								onFiledUpdate={(filed) => setLastFiled(filed)}
								onDownload={handleHistoryDownload}
							/>
						</div>
					</details>
				</>
			) : null}

			{recording ? (
				<RecordingCard
					elapsedMs={session.elapsedMs}
					streaming={session.streaming}
					clickCount={session.clickCount}
					latestThumb={
						latestPreview
							? {
									clickNumber: latestPreview.clickNumber,
									url: latestPreview.url,
								}
							: undefined
					}
					screenshotsUnavailable={session.screenshotsUnavailable}
					transcript={session.transcript}
					partial={session.partial}
					needsKey={session.needsKey}
					onProvideKey={(key) => session.provideKey(key)}
					voiceEnabled={session.voiceEnabled}
					onEnableVoice={() => void session.enableVoice()}
					flashTick={session.flashTick}
					onMark={() => void session.mark()}
					onStop={() => void session.stop()}
				/>
			) : null}

			{session.phase === "saving" ? (
				<div className="flex items-center gap-2 text-muted-foreground">
					<Loader2 className="size-4 animate-spin" /> Working…
				</div>
			) : null}

			{session.phase === "reviewing" ? (
				<ReviewPanel
					transcript={session.transcript}
					events={session.artifact?.events}
					clickPreviews={session.clickPreviews}
					onEditSegment={session.editSegment}
					saveWarning={session.saveWarning}
					lastAction={lastAction}
					modes={modes}
					primaryMode={primaryMode}
					fileDisabled={!fileBinding.projectId}
					needTargetHint={
						modes.includes("issue") && !binding.projectId && !reviewTarget
					}
					targetPicker={
						modes.includes("issue") && !binding.projectId ? (
							<TargetPicker
								client={client}
								projectId={projectId}
								value={reviewTarget?.id}
								onChange={(id, b) =>
									setReviewTarget(id ? { id, branch: b } : undefined)
								}
							/>
						) : null
					}
					onDiscard={discard}
					onCreateIssue={() => void session.submitIssue(reviewBinding)}
					onCopy={() => void handleClipboard()}
					onDownload={handleDownload}
				/>
			) : null}

			{session.phase === "done" ? (
				<DonePanel issueUrl={session.issueUrl} onReset={discard} />
			) : null}

			{session.phase === "error" ? (
				<ErrorPanel error={session.error} onReset={discard} />
			) : null}
		</div>,
		portalHost,
	);
	return (
		<>
			{portal}
			<Shutter trigger={session.flashTick} />
		</>
	);
}
