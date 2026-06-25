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
	MousePointer2,
	Square,
	Trash2,
	X,
} from "lucide-react";
import type { ReactElement } from "react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type BugToPromptClient, createFetchClient } from "../client";
import { promptTitle, renderPrompt } from "../render";
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
	clipboard,
	onDownload,
}: BugToPromptProps): ReactElement | null {
	// --- Zero-config: auto-resolve client and options when no explicit client ---
	const [auto, setAuto] = useState(() => ({
		client: createLocalFallbackClient(),
		modes: modesProp ?? (["clipboard", "download"] as OutputMode[]),
		projectId: projectIdProp,
		screenshotMode: undefined as ScreenshotMode | undefined,
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
			if (cfg) {
				setAuto({
					client: createFetchClient(base),
					modes:
						modesProp ??
						cfg.modes ??
						(["issue", "clipboard", "download"] as OutputMode[]),
					projectId: projectIdProp ?? cfg.projectId,
					screenshotMode: cfg.screenshotMode,
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
	// config > default "onMark".
	const globalScreenshotMode =
		typeof window !== "undefined"
			? (window.__BUGTOPROMPT__?.screenshotMode as ScreenshotMode | undefined)
			: undefined;
	const screenshotMode: ScreenshotMode =
		screenshotModeProp ??
		globalScreenshotMode ??
		auto.screenshotMode ??
		"onMark";

	const [open, setOpen] = useState(false);
	const [pickedWs, setPickedWs] = useState<string | undefined>();
	const [pickedBranch, setPickedBranch] = useState<string | undefined>();
	// The binding is FROZEN at record-start: navigating the app (which moves the
	// live selection) while recording must not retarget the capture's target.
	const [frozen, setFrozen] = useState<SessionBinding | undefined>();
	// Inline confirmation for clipboard/download modes.
	const [lastAction, setLastAction] = useState<
		"none" | "copied" | "downloaded"
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
	// Dedup guard so the issue-done effect only records once per session.
	const lastRecordedRef = useRef<string>("");

	const primaryMode = defaultMode ?? modes[0] ?? "issue";
	const idle = session.phase === "idle";
	const effWorkspaceId = workspaceId ?? pickedWs;
	const effBranch = branch ?? pickedBranch;
	const needsPicker = idle && !workspaceId;
	// Only nag for an AssemblyAI key on standalone, no-backend, no-key installs.
	// A host that injects an explicit `client` (e.g. the host application) is never asked.
	const showIdleKeyPrompt =
		idle && clientProp === undefined && !auto.backend && !hasConfiguredKey();

	const liveBinding: SessionBinding = {
		...(projectId ? { projectId } : {}),
		...(effWorkspaceId ? { workspaceId: effWorkspaceId } : {}),
		...(effBranch ? { branch: effBranch } : {}),
	};
	const binding = !idle && frozen ? frozen : liveBinding;

	const discard = (): void => {
		// Reviewing-phase discard: wipe screenshots so no partial history survives.
		if (session.phase === "reviewing" && session.artifact) {
			void clearShots(session.artifact.sessionId);
		}
		setFrozen(undefined);
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

	const handleClipboard = async (): Promise<void> => {
		const artifact = session.artifact;
		if (!artifact) return;
		const final = { ...artifact, transcript: session.transcript };
		const text = renderPrompt(final);
		const cb = clipboard ?? navigator.clipboard;
		await cb.writeText(text);
		setLastAction("copied");
		recordFinished("clipboard");
	};

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
			const mdUrl = URL.createObjectURL(md);
			const jsonUrl = URL.createObjectURL(json);
			const a = document.createElement("a");
			a.href = mdUrl;
			a.download = `snap-${final.sessionId}.md`;
			a.click();
			URL.revokeObjectURL(mdUrl);
			const b = document.createElement("a");
			b.href = jsonUrl;
			b.download = `snap-${final.sessionId}.json`;
			b.click();
			URL.revokeObjectURL(jsonUrl);
		}
		setLastAction("downloaded");
		recordFinished("download");
	};

	/** Download a history record (same blob logic as handleDownload). */
	const handleHistoryDownload = (rec: CaptureRecord): void => {
		const md = new Blob([rec.prompt], { type: "text/markdown" });
		const json = new Blob([JSON.stringify(rec.artifact, null, 2)], {
			type: "application/json",
		});
		if (onDownload) {
			onDownload(md, json);
		} else {
			const mdUrl = URL.createObjectURL(md);
			const jsonUrl = URL.createObjectURL(json);
			const a = document.createElement("a");
			a.href = mdUrl;
			a.download = `snap-${rec.id}.md`;
			a.click();
			URL.revokeObjectURL(mdUrl);
			const b = document.createElement("a");
			b.href = jsonUrl;
			b.download = `snap-${rec.id}.json`;
			b.click();
			URL.revokeObjectURL(jsonUrl);
		}
	};

	// Refresh captures when the panel opens.
	useEffect(() => {
		if (open) setCaptures(listCaptures());
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

	if (!open) {
		return createPortal(
			<button
				type="button"
				data-bugtoprompt
				onClick={() => setOpen(true)}
				className="fixed right-4 bottom-4 z-[9999] flex items-center gap-1.5 rounded-full bg-foreground px-3 py-2 text-background text-xs shadow-lg transition-colors hover:bg-foreground/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
			>
				<Bug className="size-4" /> Snap
			</button>,
			document.body,
		);
	}

	const recording = session.phase === "recording";

	const portal = createPortal(
		<div
			data-bugtoprompt
			className="fixed right-4 bottom-4 z-[9999] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-3 rounded-md border border-border bg-popover p-3 text-popover-foreground text-xs shadow-xl"
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
							{binding.branch ?? binding.workspaceId ?? "none"}
						</span>
					</div>
				)
			) : null}

			{session.phase === "idle" ? (
				<>
					{showIdleKeyPrompt ? (
						<KeyPrompt onSave={(key) => session.provideKey(key)} />
					) : null}
					{/* --- Capture history --- */}
					{captures.length === 0 ? (
						<p className="text-muted-foreground">No captures yet.</p>
					) : (
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
													void cb.writeText(rec.prompt);
												}}
											>
												<ClipboardCopy className="size-3.5" />
											</Button>
											<Button
												variant="ghost"
												size="sm"
												className="size-6 p-0"
												aria-label="Download"
												onClick={() => handleHistoryDownload(rec)}
											>
												<Download className="size-3.5" />
											</Button>
											<Button
												variant="ghost"
												size="sm"
												className="size-6 p-0"
												aria-label="Delete"
												onClick={() => {
													void removeCapture(rec.id).then(() =>
														setCaptures(listCaptures()),
													);
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
																projectId,
																sessionId: rec.id,
																prompt: rec.prompt,
															})
															.then((r) => {
																setLastFiled({ id: rec.id, url: r.url });
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
					)}
					{/* --- Record action --- */}
					<label className="flex cursor-pointer items-center gap-1.5 text-muted-foreground hover:text-foreground">
						<input
							type="checkbox"
							checked={wantVoice}
							onChange={(e) => setWantVoice(e.currentTarget.checked)}
							className="size-3 cursor-pointer accent-primary"
						/>
						<Mic className="size-3" />
						Voice narration
					</label>
					<p className="text-[10px] text-muted-foreground">
						Narrate the bug aloud — uses your microphone (optional).
					</p>
					<Button
						size="sm"
						onClick={() => {
							setFrozen(binding);
							void session.start(binding).then(() => {
								if (wantVoice) void session.enableVoice();
							});
						}}
					>
						<CircleDot className="size-4" /> Record
					</Button>
					<p className="text-muted-foreground">
						Click around or press Mark to capture. Enable voice narration after
						starting to record.
					</p>
				</>
			) : null}

			{recording ? (
				<>
					<div className="flex items-center justify-between">
						<span className="flex items-center gap-1.5 font-medium text-red-500 tabular-nums">
							<CircleDot className="size-4 animate-pulse" />{" "}
							{clock(session.elapsedMs)}
						</span>
						<span
							key={session.flashTick}
							className={`flex items-center gap-1.5 text-muted-foreground${
								session.flashTick > 0 ? " snap-count-pulse" : ""
							}`}
						>
							{session.markCount} mark{session.markCount === 1 ? "" : "s"}
							<span
								aria-hidden="true"
								className={`inline-block size-1.5 rounded-full ${
									session.streaming ? "bg-green-500" : "bg-amber-500"
								}`}
							/>
							<span
								className={
									session.streaming ? "text-green-500" : "text-amber-500"
								}
							>
								{session.streaming ? "live" : "rec only"}
							</span>
						</span>
					</div>
					{session.needsKey ? (
						<KeyPrompt onSave={(key) => session.provideKey(key)} />
					) : null}
					<div className="max-h-32 overflow-y-auto">
						<CaptionEditor
							transcript={session.transcript}
							partial={session.partial}
						/>
					</div>
					<div className="flex gap-2">
						<Button
							size="sm"
							variant="secondary"
							className="flex-1"
							onClick={() => void session.mark()}
						>
							<Camera className="size-4" /> Mark
						</Button>
						<Button
							size="sm"
							variant="destructive"
							className="flex-1"
							onClick={() => void session.stop()}
						>
							<Square className="size-4" /> Stop
						</Button>
					</div>
					<label className="flex cursor-pointer items-center gap-1.5 text-muted-foreground hover:text-foreground">
						<input
							type="checkbox"
							checked={session.voiceEnabled}
							onChange={() => {
								if (!session.voiceEnabled) void session.enableVoice();
							}}
							disabled={session.voiceEnabled}
							className="size-3 cursor-pointer accent-primary"
						/>
						<Mic className="size-3" />
						Voice narration
					</label>
					<label className="flex cursor-pointer items-center gap-1.5 text-muted-foreground hover:text-foreground">
						<input
							type="checkbox"
							checked={session.snapOnClick}
							onChange={(e) => session.setSnapOnClick(e.currentTarget.checked)}
							className="size-3 cursor-pointer accent-primary"
						/>
						<MousePointer2 className="size-3" />
						Snap on click
					</label>
				</>
			) : null}

			{session.phase === "saving" ? (
				<div className="flex items-center gap-2 text-muted-foreground">
					<Loader2 className="size-4 animate-spin" /> Working…
				</div>
			) : null}

			{session.phase === "reviewing" ? (
				<>
					<div className="max-h-40 overflow-y-auto">
						<CaptionEditor
							transcript={session.transcript}
							events={session.artifact?.events}
							editable
							onEdit={session.editSegment}
						/>
					</div>
					<div className="text-muted-foreground">
						{session.markCount} screenshot{session.markCount === 1 ? "" : "s"}{" "}
						captured.
					</div>
					{lastAction === "copied" ? (
						<p className="text-green-500">Copied to clipboard!</p>
					) : lastAction === "downloaded" ? (
						<p className="text-green-500">Downloaded!</p>
					) : null}
					<div className="flex flex-wrap gap-2">
						<Button size="sm" variant="ghost" onClick={discard}>
							Discard
						</Button>
						{modes.includes("issue") && (
							<Button
								size="sm"
								variant={primaryMode === "issue" ? "default" : "secondary"}
								disabled={!binding.projectId}
								onClick={() => void session.submitIssue()}
							>
								File issue
							</Button>
						)}
						{modes.includes("clipboard") && (
							<Button
								size="sm"
								variant={primaryMode === "clipboard" ? "default" : "secondary"}
								onClick={() => void handleClipboard()}
							>
								<ClipboardCopy className="size-4" /> Copy
							</Button>
						)}
						{modes.includes("download") && (
							<Button
								size="sm"
								variant={primaryMode === "download" ? "default" : "secondary"}
								onClick={handleDownload}
							>
								<Download className="size-4" /> Download
							</Button>
						)}
					</div>
					{modes.includes("issue") && !binding.projectId ? (
						<p className="text-muted-foreground">
							Select a project to file the issue.
						</p>
					) : null}
				</>
			) : null}

			{session.phase === "done" ? (
				<>
					<a
						href={session.issueUrl}
						target="_blank"
						rel="noreferrer"
						className="flex items-center gap-1.5 font-medium text-primary hover:underline"
					>
						<ExternalLink className="size-4" /> Issue filed
					</a>
					<Button size="sm" variant="secondary" onClick={discard}>
						New capture
					</Button>
				</>
			) : null}

			{session.phase === "error" ? (
				<>
					<p role="alert" className="flex items-start gap-1.5 text-destructive">
						<CircleAlert className="size-4 shrink-0" />
						{session.error}
					</p>
					<Button size="sm" variant="secondary" onClick={discard}>
						Reset
					</Button>
				</>
			) : null}
		</div>,
		document.body,
	);
	return (
		<>
			{portal}
			<Shutter trigger={session.flashTick} />
		</>
	);
}
