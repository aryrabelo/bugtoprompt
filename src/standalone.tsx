/**
 * Self-mounting standalone entry — bundles React, ReactDOM, and the overlay.
 * One <script> tag renders the widget styled on any page.
 *
 * Config priority (first truthy wins per field):
 *   1. data-* attrs on the <script> tag (data-base, data-modes, data-project-id,
 *      data-screenshot-mode, data-default-mode, data-assemblyai-key)
 *   2. window.__BUGTOPROMPT__
 *   3. BugToPrompt's own zero-config resolution (meta / server / fallback)
 *
 * `data-assemblyai-key` is not a BugToPromptProp — it is persisted to the
 * browser key-store at parse time so live transcription works without a backend.
 *
 * Auto-mounts on DOMContentLoaded unless window.__BUGTOPROMPT__.manual === true.
 * Always exposes window.BugToPrompt = { mount, unmount } for programmatic use.
 */
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import css from "../dist/bugtoprompt.css";
import type { BugToPromptProps, OutputMode } from "./overlay/BugToPrompt";
import { BugToPrompt } from "./overlay/BugToPrompt";
import { saveAssemblyKey } from "./overlay/key-store";
import type { ScreenshotMode } from "./overlay/useSession";

// ---------------------------------------------------------------------------
// Module-level singleton state
// ---------------------------------------------------------------------------

let _container: HTMLDivElement | null = null;
let _root: Root | null = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function injectStyles(): void {
	if (document.querySelector("[data-bugtoprompt-style]")) return;
	const style = document.createElement("style");
	style.setAttribute("data-bugtoprompt-style", "");
	style.textContent = css;
	document.head.appendChild(style);
}

/** Read config from the <script data-*> element that loaded this file.
 *  `document.currentScript` is only available during synchronous evaluation,
 *  so this is called at parse time — not inside a deferred callback. */
function readScriptConfig(): Partial<BugToPromptProps> {
	const script = document.currentScript as HTMLScriptElement | null;
	const ds = script?.dataset;
	if (!ds) return {};

	const cfg: Partial<BugToPromptProps> = {};
	if (ds.base) cfg.baseUrl = ds.base;
	if (ds.modes) {
		cfg.modes = ds.modes.split(",").map((m) => m.trim()) as OutputMode[];
	}
	if (ds.projectId) cfg.projectId = ds.projectId;
	if (ds.screenshotMode) {
		cfg.screenshotMode = ds.screenshotMode as ScreenshotMode;
	}
	if (ds.defaultMode) cfg.defaultMode = ds.defaultMode as OutputMode;
	// Not a BugToPromptProp: persist the key client-side so the streaming-token
	// resolver can mint v3 tokens directly against AssemblyAI without a backend.
	if (ds.assemblyaiKey) saveAssemblyKey(ds.assemblyaiKey);
	return cfg;
}

/** Read supplemental config from window.__BUGTOPROMPT__. */
function readGlobalConfig(): Partial<BugToPromptProps> {
	const g = window.__BUGTOPROMPT__;
	if (!g) return {};
	const cfg: Partial<BugToPromptProps> = {};
	if (g.baseUrl) cfg.baseUrl = g.baseUrl;
	if (g.modes) cfg.modes = g.modes;
	if (g.defaultMode) cfg.defaultMode = g.defaultMode;
	if (g.projectId) cfg.projectId = g.projectId;
	if (g.screenshotMode) cfg.screenshotMode = g.screenshotMode;
	return cfg;
}

// Snapshot the <script> dataset NOW — currentScript is null after synchronous parse.
const _scriptConfig: Partial<BugToPromptProps> =
	typeof document !== "undefined" ? readScriptConfig() : {};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Mount the bugtoprompt overlay. Idempotent — calling twice has no effect.
 * Returns an unmount function for convenience (same reference as `unmount`).
 */
export function mount(opts?: Partial<BugToPromptProps>): () => void {
	if (typeof document === "undefined") return unmount;
	if (_container) return unmount; // already mounted — no-op

	injectStyles();

	const props: BugToPromptProps = {
		...readGlobalConfig(),
		..._scriptConfig,
		...opts,
	};

	_container = document.createElement("div");
	document.body.appendChild(_container);
	_root = createRoot(_container);
	_root.render(<BugToPrompt {...props} />);

	return unmount;
}

/** Remove the overlay container from the DOM. The injected stylesheet stays. */
export function unmount(): void {
	if (!_root) return;
	_root.unmount();
	_root = null;
	_container?.remove();
	_container = null;
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

if (typeof window !== "undefined") {
	window.BugToPrompt = { mount, unmount };
}

if (typeof document !== "undefined" && !window.__BUGTOPROMPT__?.manual) {
	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", () => {
			mount();
		});
	} else {
		mount();
	}
}
