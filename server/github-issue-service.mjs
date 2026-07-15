#!/usr/bin/env node
/**
 * BugToPrompt — reference gh-backed issue service.
 *
 * A dependency-free Node ESM HTTP backend implementing the BugToPromptClient
 * contract (see src/client/index.ts). Any host application can point the
 * overlay at this process; configure everything via environment variables —
 * no code edits required.
 *
 * Endpoints served:
 *
 *   GET  /bugtoprompt/config        → advertised modes + projectId + defaultMode +
 *                                       transcriptionProvider ("assemblyai" | "local" |
 *                                       "unconfigured")
 *   GET  /targets?projectId=...     → configured repos as Target[]
 *   POST /artifact                  → persist artifact.json + audio + screenshots
 *   POST /transcribe                → batch transcript of saved audio (local or
 *                                       AssemblyAI, see BUGTOPROMPT_TRANSCRIBE)
 *   POST /streaming-token           → mint an AssemblyAI temp token (best-effort)
 *   POST /issue                     → `gh issue create` against the chosen repo
 *
 * Issue creation is OFF by default; enable with BUGTOPROMPT_ENABLE_ISSUES=1.
 * No secrets are written to disk.
 *
 * Environment variables
 * ─────────────────────────────────────────────────────────────────────────
 * Variable                    Default        Purpose
 * ─────────────────────────────────────────────────────────────────────────
 * BUGTOPROMPT_HOST            127.0.0.1      Bind address. Set to 0.0.0.0 to
 *                                            expose beyond localhost (add auth).
 * BUGTOPROMPT_PORT            4127           Listen port.
 * BUGTOPROMPT_REPOS           (none)         Comma-separated repos exposed as
 *                                            targets: owner/repo[#branch].
 *                                            E.g. "acme/web,acme/api#develop"
 * BUGTOPROMPT_PROJECT_ID      bugtoprompt    Advertised projectId returned by
 *                                            GET /bugtoprompt/config. Used by
 *                                            autoConfig to match the overlay.
 * BUGTOPROMPT_ENABLE_ISSUES   0              Set to 1 to enable POST /issue.
 *                                            Requires the `gh` CLI to be
 *                                            authenticated in this environment.
 * BUGTOPROMPT_ALLOWED_ORIGINS (none)         Extra comma-separated origins
 *                                            allowed by CORS + CSRF guard.
 *                                            localhost & 127.0.0.1 are always
 *                                            trusted; Tauri origins too.
 * BUGTOPROMPT_TOKEN           (none)         Shared secret. When set, every
 *                                            non-OPTIONS request must present it
 *                                            as "Authorization: Bearer <token>"
 *                                            or "x-bugtoprompt-token: <token>".
 * BUGTOPROMPT_SCREENSHOT_MODE (none)         Passed through to the client via
 *                                            GET /bugtoprompt/config.
 * BUGTOPROMPT_ENV             (none)         Environment label (e.g. "staging")
 *                                            passed through via /bugtoprompt/config.
 * BUGTOPROMPT_CONFIG          (none)         Inline JSON string or path to a
 *                                            JSON file with the full config
 *                                            object. Merged before env overrides.
 *                                            Keys: repos, projectId, issueMode,
 *                                            defaultMode, screenshotMode, env.
 * ASSEMBLYAI_API_KEY          (none)         AssemblyAI API key. Required for
 *                                            POST /streaming-token. For
 *                                            POST /transcribe, local mode is
 *                                            used when parakeet-mlx is available;
 *                                            otherwise this key is required.
 * BUGTOPROMPT_TRANSCRIBE      auto           Provider: "local", "assemblyai", or
 *                                            "auto" (local if available, else
 *                                            AssemblyAI key, else unconfigured).
 * BUGTOPROMPT_VOCAB           (none)         Path to JSON file merged over the
 *                                            built-in vocabulary for local
 *                                            transcription corrections.
 * ─────────────────────────────────────────────────────────────────────────
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
	detectLocalEngine,
	LOCAL_TRANSCRIBE_TIMEOUT_MS,
	localTranscribe,
	resolveTranscribeProvider,
} from "./local-transcribe.mjs";
import {
	buildHealthPayload,
	detectGhState,
	detectTranscriptionState,
	publishedGhState,
} from "./service-preflight.mjs";
import {
	isOriginAllowed,
	isValidScreenshotRef,
	isValidSessionId,
	parseAllowedOrigins,
} from "./service-security.mjs";
import { transcriptToSegments } from "./transcript-segments.mjs";

const execFileAsync = promisify(execFile);

const DEFAULT_PORT = 4127;
const DEFAULT_BRANCH = "main";
const CAPTURES_ROOT = resolve(process.cwd(), ".bugtoprompt", "captures");
const ASSEMBLYAI_TOKEN_URL = "https://streaming.assemblyai.com/v3/token";
const ASSEMBLYAI_API_BASE = "https://api.assemblyai.com";
const TRANSCRIBE_POLL_INTERVAL_MS = 3000;
const TRANSCRIBE_TIMEOUT_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Load raw config: BUGTOPROMPT_CONFIG (inline JSON or path) → file → {}. */
function loadRawConfig() {
	const raw = process.env.BUGTOPROMPT_CONFIG;
	if (raw?.trim()) {
		const trimmed = raw.trim();
		if (trimmed.startsWith("{")) {
			return JSON.parse(trimmed);
		}
		return JSON.parse(readFileSync(resolve(trimmed), "utf8"));
	}
	const local = resolve(process.cwd(), ".bugtoprompt.github.json");
	if (existsSync(local)) {
		return JSON.parse(readFileSync(local, "utf8"));
	}
	return {};
}

/** Normalize one repo entry (string `owner/repo[#branch]` or object) → target. */
function normalizeRepo(entry) {
	if (typeof entry === "string") {
		const [repoPart, branchPart] = entry.split("#");
		const repo = repoPart.trim();
		if (!repo) return null;
		return {
			id: repo,
			name: repo,
			repo,
			branch: (branchPart || "").trim() || DEFAULT_BRANCH,
		};
	}
	if (entry && typeof entry === "object") {
		const repo = (entry.repo || entry.id || "").trim();
		if (!repo) return null;
		return {
			id: (entry.id || repo).trim(),
			name: (entry.name || repo).trim(),
			repo,
			branch: (entry.branch || "").trim() || DEFAULT_BRANCH,
		};
	}
	return null;
}

function buildConfig() {
	const cfg = loadRawConfig();

	const issueMode =
		cfg.issueMode === true || process.env.BUGTOPROMPT_ENABLE_ISSUES === "1";

	// Repos: config `repos` array first, then BUGTOPROMPT_REPOS comma list.
	const entries = [];
	if (Array.isArray(cfg.repos)) entries.push(...cfg.repos);
	if (process.env.BUGTOPROMPT_REPOS) {
		entries.push(
			...process.env.BUGTOPROMPT_REPOS.split(",").map((s) => s.trim()),
		);
	}
	const targets = [];
	const byId = new Map();
	for (const entry of entries) {
		const t = normalizeRepo(entry);
		if (t && !byId.has(t.id)) {
			byId.set(t.id, t);
			targets.push(t);
		}
	}

	const projectId =
		cfg.projectId || process.env.BUGTOPROMPT_PROJECT_ID || "bugtoprompt";
	const screenshotMode =
		cfg.screenshotMode || process.env.BUGTOPROMPT_SCREENSHOT_MODE;
	const env = cfg.env || process.env.BUGTOPROMPT_ENV;

	const enabledModes = issueMode
		? ["issue", "clipboard", "download"]
		: ["clipboard", "download"];
	const defaultMode = cfg.defaultMode || (issueMode ? "issue" : "clipboard");

	return {
		issueMode,
		targets,
		byId,
		projectId,
		screenshotMode,
		env,
		enabledModes,
		defaultMode,
		host: process.env.BUGTOPROMPT_HOST || "127.0.0.1",
		port: Number(process.env.BUGTOPROMPT_PORT) || DEFAULT_PORT,
	};
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const ALLOWED_ORIGINS = parseAllowedOrigins(process.env);

function corsHeaders(origin) {
	const headers = {
		"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
		"Access-Control-Allow-Headers": "Content-Type, Authorization",
		"Access-Control-Max-Age": "86400",
	};
	if (origin && isOriginAllowed(origin, ALLOWED_ORIGINS)) {
		headers["Access-Control-Allow-Origin"] = origin;
		headers.Vary = "Origin";
	}
	return headers;
}

function sendJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		...(res.bugCors || {}),
		"Content-Type": "application/json",
	});
	res.end(payload);
}

function readJsonBody(req) {
	return new Promise((resolvePromise, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (c) => {
			size += c.length;
			// 64 MB ceiling — screenshots/audio are base64 inline.
			if (size > 64 * 1024 * 1024) {
				reject(new Error("payload too large"));
				req.destroy();
				return;
			}
			chunks.push(c);
		});
		req.on("end", () => {
			if (chunks.length === 0) {
				resolvePromise({});
				return;
			}
			try {
				resolvePromise(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			} catch (err) {
				reject(err);
			}
		});
		req.on("error", reject);
	});
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * @param {import("node:http").ServerResponse} res
 * @param {object} config
 * @param {"assemblyai" | "local" | "unconfigured"} transcriptionProvider  which
 *        backend serves POST /transcribe — see resolveTranscribeProvider.
 */
function handleConfig(res, config, transcriptionProvider) {
	const body = {
		modes: config.enabledModes,
		defaultMode: config.defaultMode,
		projectId: config.projectId,
		transcriptionProvider,
	};
	if (config.screenshotMode) body.screenshotMode = config.screenshotMode;
	if (config.env) body.env = config.env;
	sendJson(res, 200, body);
}

function handleTargets(res, config) {
	// Expose only the public Target shape; `repo` stays server-side.
	sendJson(
		res,
		200,
		config.targets.map((t) => ({ id: t.id, name: t.name, branch: t.branch })),
	);
}

async function handleArtifact(req, res) {
	const body = await readJsonBody(req);
	const artifact = body.artifact;
	if (!artifact || typeof artifact.sessionId !== "string") {
		sendJson(res, 400, { error: "artifact.sessionId required" });
		return;
	}
	const sessionId = artifact.sessionId;
	if (!isValidSessionId(sessionId)) {
		sendJson(res, 400, { error: "invalid sessionId" });
		return;
	}
	// Validate the FULL screenshot payload BEFORE creating the dir or writing
	// anything, so a rejected capture never leaves a partial capture dir behind
	// (and never overwrites a prior capture with the same sessionId on a 400).
	const toWrite = [];
	const seenRefs = new Set();
	if (Array.isArray(body.screenshotsBase64)) {
		const snapshots = Array.isArray(artifact.snapshots)
			? artifact.snapshots
			: [];
		for (let i = 0; i < body.screenshotsBase64.length; i++) {
			const b64 = body.screenshotsBase64[i];
			if (typeof b64 !== "string" || b64.length === 0) continue;
			const ref = snapshots[i]?.screenshotRef;
			if (!isValidScreenshotRef(ref)) {
				sendJson(res, 400, {
					error: `screenshot ${i} missing a valid screenshotRef (expected snap-NNNN.jpg)`,
				});
				return;
			}
			if (seenRefs.has(ref)) {
				sendJson(res, 400, {
					error: `screenshot ${i} reuses screenshotRef ${ref}; each ref must be unique`,
				});
				return;
			}
			seenRefs.add(ref);
			toWrite.push({ ref, b64 });
		}
	}

	const dir = join(CAPTURES_ROOT, sessionId);
	mkdirSync(dir, { recursive: true });

	writeFileSync(join(dir, "artifact.json"), JSON.stringify(artifact, null, 2));

	if (typeof body.audioBase64 === "string" && body.audioBase64.length > 0) {
		writeFileSync(
			join(dir, "audio.webm"),
			Buffer.from(body.audioBase64, "base64"),
		);
	}

	// screenshotRef IS the persisted filename: prompt, artifact JSON, JPEG, and
	// issue-local path stay identical rather than inventing screenshot-NNN.png.
	for (const { ref, b64 } of toWrite) {
		writeFileSync(join(dir, ref), Buffer.from(b64, "base64"));
	}

	sendJson(res, 200, { dir, sessionId });
}

async function handleTranscribe(req, res) {
	const body = await readJsonBody(req);
	const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
	if (!sessionId) {
		sendJson(res, 400, { error: "sessionId required" });
		return;
	}
	if (!isValidSessionId(sessionId)) {
		sendJson(res, 400, { error: "invalid sessionId" });
		return;
	}
	console.log(`[transcribe] start session=${sessionId}`);

	const dir = join(CAPTURES_ROOT, sessionId);
	const audioPath = join(dir, "audio.webm");
	if (!existsSync(audioPath)) {
		console.error(
			`[transcribe] audio missing session=${sessionId} path=${audioPath}`,
		);
		sendJson(res, 400, { error: `audio not found for session ${sessionId}` });
		return;
	}

	if (transcriptionProvider === "unconfigured") {
		console.error("[transcribe] transcription not configured");
		sendJson(res, 501, { error: "transcription not configured" });
		return;
	}

	if (transcriptionProvider === "local") {
		try {
			console.log(`[transcribe] local start session=${sessionId}`);
			const transcript = await localTranscribe(audioPath, {
				execFile: execFileAsync,
				timeoutMs: LOCAL_TRANSCRIBE_TIMEOUT_MS,
			});
			console.log(
				`[transcribe] local completed session=${sessionId} segments=${transcript.length}`,
			);
			persistTranscript(sessionId, transcript);
			sendJson(res, 200, { transcript });
		} catch (err) {
			console.error(
				`[transcribe] local failed session=${sessionId} ${String(err)}`,
			);
			sendJson(res, 502, {
				error: `local transcription failed: ${String(err)}`,
			});
		}
		return;
	}

	const key = process.env.ASSEMBLYAI_API_KEY;

	try {
		const audio = readFileSync(audioPath);
		console.log(
			`[transcribe] uploading session=${sessionId} bytes=${audio.length}`,
		);
		const uploadRes = await fetch(`${ASSEMBLYAI_API_BASE}/v2/upload`, {
			method: "POST",
			headers: {
				Authorization: key,
				"Content-Type": "application/octet-stream",
			},
			body: audio,
		});
		if (!uploadRes.ok) {
			const detail = await readUpstreamError(uploadRes);
			console.error(
				`[transcribe] upload failed session=${sessionId} status=${uploadRes.status} ${detail}`,
			);
			sendJson(res, 502, {
				error: `AssemblyAI upload failed: ${uploadRes.status} ${detail}`,
			});
			return;
		}
		const uploaded = await uploadRes.json();
		const uploadUrl = uploaded?.upload_url;
		if (typeof uploadUrl !== "string" || !uploadUrl) {
			console.error(
				`[transcribe] upload response missing url session=${sessionId}`,
			);
			sendJson(res, 502, {
				error: "AssemblyAI upload response missing upload_url",
			});
			return;
		}
		console.log(`[transcribe] upload ok session=${sessionId}`);

		const submitRes = await fetch(`${ASSEMBLYAI_API_BASE}/v2/transcript`, {
			method: "POST",
			headers: { Authorization: key, "Content-Type": "application/json" },
			body: JSON.stringify({
				audio_url: uploadUrl,
				speech_models: ["universal-3-pro", "universal-2"],
				punctuate: true,
				format_text: true,
			}),
		});
		if (!submitRes.ok) {
			const detail = await readUpstreamError(submitRes);
			console.error(
				`[transcribe] submit failed session=${sessionId} status=${submitRes.status} ${detail}`,
			);
			sendJson(res, 502, {
				error: `AssemblyAI transcript submit failed: ${submitRes.status} ${detail}`,
			});
			return;
		}
		const submitted = await submitRes.json();
		const transcriptId = submitted?.id;
		if (typeof transcriptId !== "string" || !transcriptId) {
			console.error(
				`[transcribe] submit response missing id session=${sessionId}`,
			);
			sendJson(res, 502, {
				error: "AssemblyAI transcript response missing id",
			});
			return;
		}
		console.log(
			`[transcribe] submitted session=${sessionId} transcriptId=${transcriptId}`,
		);

		const deadline = Date.now() + TRANSCRIBE_TIMEOUT_MS;
		let lastStatus = "";
		let final = null;
		while (Date.now() < deadline) {
			const pollRes = await fetch(
				`${ASSEMBLYAI_API_BASE}/v2/transcript/${transcriptId}`,
				{ headers: { Authorization: key } },
			);
			if (!pollRes.ok) {
				const detail = await readUpstreamError(pollRes);
				console.error(
					`[transcribe] poll failed session=${sessionId} transcriptId=${transcriptId} status=${pollRes.status} ${detail}`,
				);
				sendJson(res, 502, {
					error: `AssemblyAI poll failed: ${pollRes.status} ${detail}`,
				});
				return;
			}
			const data = await pollRes.json();
			if (data.status !== lastStatus) {
				console.log(
					`[transcribe] status session=${sessionId} transcriptId=${transcriptId} ${lastStatus || "(none)"} -> ${data.status}`,
				);
				lastStatus = data.status;
			}
			if (data.status === "completed") {
				final = data;
				break;
			}
			if (data.status === "error" || data.status === "failed") {
				console.error(
					`[transcribe] upstream failed session=${sessionId} transcriptId=${transcriptId} cause=${data.error || data.status}`,
				);
				sendJson(res, 502, {
					error: `AssemblyAI transcription failed: ${data.error || data.status}`,
				});
				return;
			}
			await delay(TRANSCRIBE_POLL_INTERVAL_MS);
		}
		if (!final) {
			console.error(
				`[transcribe] timeout session=${sessionId} transcriptId=${transcriptId}`,
			);
			sendJson(res, 504, { error: "AssemblyAI transcription timed out" });
			return;
		}

		const transcript = transcriptToSegments(final);
		console.log(
			`[transcribe] completed session=${sessionId} transcriptId=${transcriptId} segments=${transcript.length}`,
		);
		persistTranscript(sessionId, transcript);
		sendJson(res, 200, { transcript });
	} catch (err) {
		console.error(`[transcribe] failed session=${sessionId} ${String(err)}`);
		sendJson(res, 502, { error: `AssemblyAI request failed: ${String(err)}` });
	}
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** Best-effort short body text from a failed upstream response. */
async function readUpstreamError(res) {
	try {
		return (await res.text()).replace(/\s+/g, " ").trim().slice(0, 300);
	} catch {
		return "";
	}
}

/** Persist the batch transcript back into the session's artifact.json. */
function persistTranscript(sessionId, transcript) {
	if (!isValidSessionId(sessionId)) return;
	const file = join(CAPTURES_ROOT, sessionId, "artifact.json");
	if (!existsSync(file)) return;
	try {
		const artifact = JSON.parse(readFileSync(file, "utf8"));
		artifact.transcript = transcript;
		artifact.transcriptionMode = "batch-fallback";
		writeFileSync(file, JSON.stringify(artifact, null, 2));
	} catch (err) {
		console.error(
			`[transcribe] persist failed session=${sessionId} ${String(err)}`,
		);
	}
}

async function handleStreamingToken(req, res) {
	await readJsonBody(req);
	if (transcriptionProvider === "local") {
		sendJson(res, 501, { error: "streaming not available in local mode" });
		return;
	}
	if (transcriptionProvider === "unconfigured") {
		sendJson(res, 501, { error: "ASSEMBLYAI_API_KEY not configured" });
		return;
	}
	const key = process.env.ASSEMBLYAI_API_KEY;
	try {
		const expiresInSeconds = 300;
		const upstream = await fetch(
			`${ASSEMBLYAI_TOKEN_URL}?expires_in_seconds=${expiresInSeconds}`,
			{ headers: { Authorization: key } },
		);
		if (!upstream.ok) {
			sendJson(res, 502, {
				error: `AssemblyAI token mint failed: ${upstream.status}`,
			});
			return;
		}
		const data = await upstream.json();
		if (!data || typeof data.token !== "string") {
			sendJson(res, 502, { error: "AssemblyAI token response missing token" });
			return;
		}
		sendJson(res, 200, {
			token: data.token,
			expiresAt: Date.now() + expiresInSeconds * 1000,
		});
	} catch (err) {
		sendJson(res, 502, { error: `AssemblyAI request failed: ${String(err)}` });
	}
}

/** Read a previously-saved artifact for a session, or null. */
function readArtifact(sessionId) {
	const file = join(CAPTURES_ROOT, sessionId, "artifact.json");
	if (!isValidSessionId(sessionId)) return null;
	if (!existsSync(file)) return null;
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}

/** Derive an issue title from the saved artifact (transcript → page → session). */
function deriveTitle(artifact, sessionId) {
	if (artifact && Array.isArray(artifact.transcript)) {
		const text = artifact.transcript
			.map((s) => (s && typeof s.text === "string" ? s.text : ""))
			.join(" ")
			.replace(/\s+/g, " ")
			.trim();
		if (text) {
			const clipped = text.length > 72 ? `${text.slice(0, 69)}...` : text;
			return `BugToPrompt: ${clipped}`;
		}
	}
	if (artifact && typeof artifact.pageUrl === "string" && artifact.pageUrl) {
		return `BugToPrompt: ${artifact.pageUrl}`;
	}
	return `BugToPrompt capture ${sessionId}`;
}

async function handleIssue(req, res, config) {
	if (!config.issueMode) {
		sendJson(res, 403, { error: "issue mode disabled" });
		return;
	}
	const body = await readJsonBody(req);
	const sessionId = body.sessionId;
	if (typeof sessionId !== "string" || !sessionId) {
		sendJson(res, 400, { error: "sessionId required" });
		return;
	}
	if (!isValidSessionId(sessionId)) {
		sendJson(res, 400, { error: "invalid sessionId" });
		return;
	}

	// Resolve the target repo: requested targetId, else the first configured.
	const target =
		(body.targetId && config.byId.get(body.targetId)) || config.targets[0];
	if (!target) {
		sendJson(res, 400, { error: "no repository configured" });
		return;
	}

	const artifact = readArtifact(sessionId);
	const title = deriveTitle(artifact, sessionId);
	const issueBody =
		typeof body.prompt === "string" && body.prompt
			? body.prompt
			: `BugToPrompt capture ${sessionId}`;

	const bodyFile = join(tmpdir(), `bugtoprompt-issue-${sessionId}.md`);
	writeFileSync(bodyFile, issueBody);

	try {
		const { stdout } = await execFileAsync("gh", [
			"issue",
			"create",
			"--repo",
			target.repo,
			"--title",
			title,
			"--body-file",
			bodyFile,
		]);
		const url = stdout.trim().split(/\s+/).pop() || "";
		const match = url.match(/\/issues\/(\d+)/);
		const number = match ? Number(match[1]) : 0;
		sendJson(res, 200, { created: true, number, url });
	} catch (err) {
		const detail = err?.stderr ? String(err.stderr).trim() : String(err);
		sendJson(res, 502, { error: `gh issue create failed: ${detail}` });
	}
}

/** GET /health — self-diagnosing preflight. Never exposes tokens. */
function handleHealth(res, config, ghState) {
	sendJson(
		res,
		200,
		buildHealthPayload({
			issues: config.issueMode,
			repos: config.targets.length,
			gh: publishedGhState(ghState),
			transcription: transcriptionState,
		}),
	);
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const config = buildConfig();

// Fail fast: issue mode with no repository to file against is a misconfig, not
// a degraded-but-usable state — refuse to start rather than accept issues we
// can never route.
if (config.issueMode && config.targets.length === 0) {
	console.error(
		"bugtoprompt: BUGTOPROMPT_ENABLE_ISSUES=1 but no repository is configured " +
			"(set BUGTOPROMPT_REPOS or config.repos).",
	);
	process.exit(1);
}

// Resolve `gh` availability + auth in the BACKGROUND so a slow or hung
// `gh auth status` never delays the HTTP listener — capture and transcription
// work even when issue mode is off. Both probes are bounded by a timeout;
// never surfaces a token, only ready/missing/unauthenticated (or pending).
let ghState = "pending";
const GH_PROBE_TIMEOUT_MS = 5_000;
detectGhState({
	lookup: () =>
		execFileAsync("gh", ["--version"], { timeout: GH_PROBE_TIMEOUT_MS }).then(
			() => true,
			() => false,
		),
	// `--active` scopes the probe to the ACTIVE account: a valid active login is
	// no longer reported as unauthenticated just because some other stale
	// account/host configured on the machine has expired credentials.
	authStatus: () =>
		execFileAsync("gh", ["auth", "status", "--active"], {
			timeout: GH_PROBE_TIMEOUT_MS,
		}),
}).then((state) => {
	ghState = state;
});

// Resolve transcription provider once at startup. Local engine is preferred in
// auto/local mode; AssemblyAI key is required for cloud-only mode.
const localEngineReady = await detectLocalEngine(execFileAsync);
const transcriptionProvider = resolveTranscribeProvider(process.env, {
	localReady: localEngineReady,
});
const transcriptionState = await detectTranscriptionState({
	apiKey: process.env.ASSEMBLYAI_API_KEY,
	detectLocal: async () => localEngineReady,
});

/** True when no shared secret is configured, or the request presented it. */
function presentsValidToken(req) {
	const token = process.env.BUGTOPROMPT_TOKEN;
	if (!token) return true;
	const auth = req.headers.authorization || "";
	const presented = auth.startsWith("Bearer ")
		? auth.slice(7)
		: req.headers["x-bugtoprompt-token"];
	return presented === token;
}

const server = createServer((req, res) => {
	const origin = req.headers.origin;
	res.bugCors = corsHeaders(origin);
	// /health answers before the CORS/auth guards so any local caller (extension
	// popup, dev harness) can probe readiness. But when BUGTOPROMPT_TOKEN is set,
	// unauthenticated callers get ONLY a minimal liveness response — repo count
	// and gh/transcription readiness stay behind the token, honoring the
	// "every non-OPTIONS request must present it" contract while keeping the
	// discovery ping (ok:true) open.
	if (
		req.method === "GET" &&
		new URL(req.url || "/", "http://localhost").pathname === "/health"
	) {
		if (presentsValidToken(req)) handleHealth(res, config, ghState);
		else sendJson(res, 200, { ok: true });
		return;
	}
	// CSRF guard: a browser request from a disallowed Origin is rejected outright
	// (a forged cross-site POST still executes server-side even if CORS hides the
	// response, so we must refuse it, not just omit the ACAO header).
	if (origin && !isOriginAllowed(origin, ALLOWED_ORIGINS)) {
		sendJson(res, 403, { error: "origin not allowed" });
		return;
	}
	// Optional shared-secret auth: when BUGTOPROMPT_TOKEN is set, every non-OPTIONS
	// request must present it.
	if (
		process.env.BUGTOPROMPT_TOKEN &&
		req.method !== "OPTIONS" &&
		!presentsValidToken(req)
	) {
		sendJson(res, 401, { error: "unauthorized" });
		return;
	}
	if (req.method === "OPTIONS") {
		res.writeHead(204, res.bugCors);
		res.end();
		return;
	}

	const url = new URL(req.url || "/", `http://localhost:${config.port}`);
	const path = url.pathname;

	const dispatch = async () => {
		if (req.method === "GET" && path === "/bugtoprompt/config") {
			handleConfig(res, config, transcriptionProvider);
			return;
		}
		if (req.method === "GET" && path === "/targets") {
			handleTargets(res, config);
			return;
		}
		if (req.method === "POST" && path === "/artifact") {
			await handleArtifact(req, res);
			return;
		}
		if (req.method === "POST" && path === "/transcribe") {
			await handleTranscribe(req, res);
			return;
		}
		if (req.method === "POST" && path === "/streaming-token") {
			await handleStreamingToken(req, res);
			return;
		}
		if (req.method === "POST" && path === "/issue") {
			await handleIssue(req, res, config);
			return;
		}
		sendJson(res, 404, { error: "not found" });
	};

	dispatch().catch((err) => {
		sendJson(res, 500, { error: String(err?.message ? err.message : err) });
	});
});

server.listen(config.port, config.host, () => {
	const state = config.issueMode ? "ENABLED" : "disabled";
	console.log(
		`bugtoprompt server on http://${config.host}:${config.port} ` +
			`(issue mode ${state}; ${config.targets.length} repo target(s))`,
	);
});
