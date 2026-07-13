/**
 * Shared config + URL validation for the BugToPrompt MV3 extension.
 *
 * Dependency-free: all Chrome API access is behind small functions that accept
 * an injected `chrome`-like object so Vitest can mock it. No React, no bundler
 * runtime — just DOM/TypeScript.
 */

export type OutputMode = "issue" | "clipboard" | "download";

const OUTPUT_MODES: readonly OutputMode[] = ["issue", "clipboard", "download"];
/** Runtime guard: is `v` one of the documented output modes? */
export function isOutputMode(v: unknown): v is OutputMode {
	return (
		typeof v === "string" && (OUTPUT_MODES as readonly string[]).includes(v)
	);
}
export type ScreenshotMode = "onClick" | "perPage" | "onMark" | "off";

/** Maps a page hostname to a GitHub repo. `host` is an exact hostname or a
 *  `*.suffix` wildcard; `projectId` is an `owner/repo` slug. */
export interface SiteBinding {
	host: string;
	projectId: string;
}

/** Non-secret defaults persisted in chrome.storage.sync. */
export interface SyncConfig {
	baseUrl: string;
	modes: OutputMode[];
	defaultMode: OutputMode;
	screenshotMode: ScreenshotMode;
	autoVoice: boolean;
	/** Per-host repo mappings for non-localhost sites. Empty on localhost-only setups. */
	siteBindings: SiteBinding[];
}

export const DEFAULT_CONFIG: SyncConfig = {
	baseUrl: "http://127.0.0.1:4127",
	modes: ["issue", "clipboard", "download"],
	defaultMode: "issue",
	screenshotMode: "onClick",
	autoVoice: true,
	siteBindings: [],
};

/** Loopback hosts we accept. IPv6 loopback (::1 / [::1]) is intentionally excluded. */
const LOOPBACK_HOSTS: Record<string, true> = {
	localhost: true,
	"127.0.0.1": true,
};
/**
 * Is this a page BugToPrompt may attach to? Only plain HTTP loopback origins.
 * Rejects HTTPS, remote hosts, IPv6 loopback, chrome://, file://, and any page
 * with embedded credentials.
 */
export function isSupportedUrl(url: string | undefined | null): boolean {
	if (!url) return false;
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	if (parsed.protocol !== "http:") return false;
	if (parsed.username || parsed.password) return false;
	return LOOPBACK_HOSTS[parsed.hostname] === true;
}

/** Chrome Web Store hosts the browser forbids content-script injection on. */
const WEBSTORE_HOSTS: Record<string, true> = {
	"chromewebstore.google.com": true,
	"chrome.google.com": true,
};

export type PageKind = "loopback" | "http" | "protected" | "invalid";

/**
 * Classify a tab URL for activation:
 *   - "loopback"  plain-HTTP localhost/127.0.0.1 — always attachable (zero-config).
 *   - "http"      any other http(s) host — attachable only with a granted origin.
 *   - "protected" chrome://, file://, the Web Store, etc — never attachable.
 *   - "invalid"   unparseable or credential-bearing URLs.
 */
export function classifyPage(url: string | undefined | null): PageKind {
	if (!url) return "invalid";
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return "invalid";
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return "protected";
	}
	if (parsed.username || parsed.password) return "invalid";
	if (WEBSTORE_HOSTS[parsed.hostname] === true) return "protected";
	if (parsed.protocol === "http:" && LOOPBACK_HOSTS[parsed.hostname] === true) {
		return "loopback";
	}
	return "http";
}

/** The chrome.permissions origin pattern for a URL's origin (e.g. "https://x.com/*"). */
export function originPattern(url: string | undefined | null): string | null {
	if (!url) return null;
	try {
		return `${new URL(url).origin}/*`;
	} catch {
		return null;
	}
}

/** A page hostname (no scheme, no path/port). Used to build the origin hint. */
export function pageOrigin(url: string | undefined | null): string | undefined {
	if (!url) return undefined;
	try {
		return new URL(url).origin;
	} catch {
		return undefined;
	}
}

/** Options-editor hostname rule: an exact hostname or a `*.suffix` wildcard,
 *  never a scheme, path, port, or whitespace. */
export function isValidBindingHost(host: string): boolean {
	const value = host.trim();
	if (!value) return false;
	const body = value.startsWith("*.") ? value.slice(2) : value;
	if (!body) return false;
	return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(
		body,
	);
}

/** Options-editor repo rule: an `owner/repo` slug. */
export function isValidProjectId(projectId: string): boolean {
	return /^[\w.-]+\/[\w.-]+$/.test(projectId.trim());
}

/**
 * Resolve the mapped repo for a page hostname. An exact host match always beats
 * a `*.suffix` wildcard; among competing wildcards the longest suffix wins.
 */
export function resolveProjectId(
	bindings: SiteBinding[],
	hostname: string | undefined,
): string | undefined {
	if (!hostname) return undefined;
	const host = hostname.toLowerCase();
	for (const b of bindings) {
		if (b.host.toLowerCase() === host) return b.projectId;
	}
	let best: string | undefined;
	let bestLen = -1;
	for (const b of bindings) {
		if (!b.host.startsWith("*.")) continue;
		const suffix = b.host.slice(2).toLowerCase();
		if (host === suffix || host.endsWith(`.${suffix}`)) {
			if (suffix.length > bestLen) {
				best = b.projectId;
				bestLen = suffix.length;
			}
		}
	}
	return best;
}

/** Keep only well-formed, deduplicated bindings (last write per host wins). */
export function normalizeBindings(raw: unknown): SiteBinding[] {
	if (!Array.isArray(raw)) return [];
	const byHost = new Map<string, SiteBinding>();
	for (const entry of raw) {
		if (typeof entry !== "object" || entry === null) continue;
		const host = "host" in entry ? String(entry.host).trim() : "";
		const projectId =
			"projectId" in entry ? String(entry.projectId).trim() : "";
		if (!isValidBindingHost(host) || !isValidProjectId(projectId)) continue;
		byHost.set(host.toLowerCase(), { host, projectId });
	}
	return [...byHost.values()];
}

/**
 * Validate a sidecar base URL entered in the options page. Same loopback-HTTP
 * rule as page support, but also forbids a trailing path/query/hash beyond the
 * origin so the stored value is a clean base URL.
 */
export function isLoopbackHttpUrl(url: string | undefined | null): boolean {
	if (!url) return false;
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	if (parsed.protocol !== "http:") return false;
	if (parsed.username || parsed.password) return false;
	if (LOOPBACK_HOSTS[parsed.hostname] !== true) return false;
	if (parsed.search || parsed.hash) return false;
	return parsed.pathname === "" || parsed.pathname === "/";
}

/** Default sidecar port when the dev stack runs without a port block. */
const DEFAULT_SIDECAR_PORT = 4127;
/** GerarPosts dev-stack convention: sidecar = web port + 3 (scripts/dev.ts). */
const SIDECAR_PORT_OFFSET = 3;

/**
 * Ordered sidecar candidates for auto-discovery: the configured URL first,
 * then the current tab's web port + 3 (the dev-stack convention, so a stack
 * on :3210 finds its sidecar on :3213 with zero config), then the portless
 * default. Deduplicated, loopback-only.
 */
export function candidateBaseUrls(
	configured: string,
	tabUrl: string | undefined | null,
): string[] {
	const out: string[] = [];
	const push = (url: string): void => {
		if (!isLoopbackHttpUrl(url)) return;
		const origin = new URL(url).origin;
		if (!out.includes(origin)) out.push(origin);
	};
	push(configured);
	if (tabUrl && isSupportedUrl(tabUrl)) {
		const port = Number(new URL(tabUrl).port);
		if (Number.isInteger(port) && port > 0) {
			push(`http://127.0.0.1:${port + SIDECAR_PORT_OFFSET}`);
		}
	}
	push(`http://127.0.0.1:${DEFAULT_SIDECAR_PORT}`);
	return out;
}

/**
 * Probe candidates in order; the first one whose GET /health answers ok:true
 * wins. Falls back to the first candidate (the configured URL) so callers
 * always get a base URL to render errors against.
 */
export async function discoverBaseUrl(
	candidates: string[],
	fetchImpl: typeof fetch,
	timeoutMs = 2000,
): Promise<{ baseUrl: string; healthy: boolean }> {
	for (const baseUrl of candidates) {
		try {
			const res = await fetchImpl(`${baseUrl}/health`, {
				signal: AbortSignal.timeout(timeoutMs),
			});
			if (!res.ok) continue;
			const raw: unknown = await res.json();
			if (
				typeof raw === "object" &&
				raw !== null &&
				"ok" in raw &&
				raw.ok === true
			) {
				return { baseUrl, healthy: true };
			}
		} catch {
			// unreachable candidate — try the next one
		}
	}
	return { baseUrl: candidates[0] ?? "", healthy: false };
}

/** Minimal shape of the `chrome` API surfaces the extension uses. */
export interface ChromeLike {
	storage: {
		sync: {
			get(keys: unknown): Promise<Record<string, unknown>>;
			set(items: Record<string, unknown>): Promise<void>;
		};
		session?: {
			get(keys: unknown): Promise<Record<string, unknown>>;
			set(items: Record<string, unknown>): Promise<void>;
			remove(keys: string | string[]): Promise<void>;
		};
	};
	scripting?: {
		executeScript(injection: unknown): Promise<Array<{ result?: unknown }>>;
		insertCSS(injection: unknown): Promise<void>;
	};
	tabs?: {
		query(info: unknown): Promise<Array<{ id?: number; url?: string }>>;
		sendMessage?(tabId: number, msg: unknown): Promise<unknown>;
		onUpdated?: {
			addListener(
				cb: (
					tabId: number,
					changeInfo: { status?: string },
					tab: { url?: string },
				) => void,
			): void;
		};
	};
	permissions?: {
		request(opts: { origins: string[] }): Promise<boolean>;
		contains(opts: { origins: string[] }): Promise<boolean>;
	};
	runtime?: {
		onMessage?: {
			addListener(
				cb: (
					msg: unknown,
					sender: { tab?: { id?: number; url?: string } },
					sendResponse: (r?: unknown) => void,
				) => boolean | undefined,
			): void;
		};
		sendMessage?(msg: unknown): Promise<unknown>;
		getURL?(path: string): string;
		openOptionsPage?(): Promise<void> | void;
	};
}

const SYNC_KEYS = [
	"baseUrl",
	"modes",
	"defaultMode",
	"screenshotMode",
	"autoVoice",
	"siteBindings",
];

function coerceConfig(raw: Record<string, unknown>): SyncConfig {
	const cfg: SyncConfig = { ...DEFAULT_CONFIG };
	if (typeof raw.baseUrl === "string" && isLoopbackHttpUrl(raw.baseUrl)) {
		cfg.baseUrl = raw.baseUrl;
	}
	if (Array.isArray(raw.modes)) {
		const valid = raw.modes.filter(isOutputMode);
		if (valid.length > 0) cfg.modes = valid;
	}
	if (
		raw.defaultMode === "issue" ||
		raw.defaultMode === "clipboard" ||
		raw.defaultMode === "download"
	) {
		cfg.defaultMode = raw.defaultMode;
	}
	// A stored/patched defaultMode that isn't among the retained modes would
	// leave the overlay with a hidden primary action — pin it to the first
	// retained mode instead.
	if (!cfg.modes.includes(cfg.defaultMode)) {
		cfg.defaultMode = cfg.modes[0];
	}
	if (
		raw.screenshotMode === "onClick" ||
		raw.screenshotMode === "perPage" ||
		raw.screenshotMode === "onMark" ||
		raw.screenshotMode === "off"
	) {
		cfg.screenshotMode = raw.screenshotMode;
	}
	if (typeof raw.autoVoice === "boolean") cfg.autoVoice = raw.autoVoice;
	cfg.siteBindings = normalizeBindings(raw.siteBindings);
	return cfg;
}

/** Load the stored config, falling back to defaults for any unset/invalid field. */
export async function loadConfig(chromeApi: ChromeLike): Promise<SyncConfig> {
	const raw = await chromeApi.storage.sync.get(SYNC_KEYS);
	return coerceConfig(raw ?? {});
}

/** Persist a partial config patch; returns the merged, validated result. */
export async function saveConfig(
	chromeApi: ChromeLike,
	patch: Partial<SyncConfig>,
): Promise<SyncConfig> {
	if (patch.baseUrl !== undefined && !isLoopbackHttpUrl(patch.baseUrl)) {
		throw new Error("baseUrl must be a loopback HTTP origin");
	}
	if (
		patch.modes !== undefined &&
		(patch.modes.length === 0 || !patch.modes.every(isOutputMode))
	) {
		throw new Error(
			"modes must be a non-empty list of issue|clipboard|download",
		);
	}
	if (patch.siteBindings !== undefined) {
		for (const b of patch.siteBindings) {
			if (!isValidBindingHost(b.host) || !isValidProjectId(b.projectId)) {
				throw new Error(`Invalid site binding: ${b.host} → ${b.projectId}`);
			}
		}
	}
	const current = await loadConfig(chromeApi);
	const merged: SyncConfig = { ...current, ...patch };
	if (!merged.modes.includes(merged.defaultMode)) {
		merged.defaultMode = merged.modes[0];
	}
	merged.siteBindings = normalizeBindings(merged.siteBindings);
	const payload: Record<string, unknown> = {
		baseUrl: merged.baseUrl,
		modes: merged.modes,
		defaultMode: merged.defaultMode,
		screenshotMode: merged.screenshotMode,
		autoVoice: merged.autoVoice,
		siteBindings: merged.siteBindings,
	};
	await chromeApi.storage.sync.set(payload);
	return merged;
}
