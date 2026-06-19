/**
 * Auto-configuration resolver for zero-config BugToPrompt usage.
 * Resolves a backend base URL from environment hints, fetches server-side
 * config, and provides a local fallback client for clipboard/download-only
 * usage when no backend is configured.
 */
import type { BugToPromptClient } from "../client";
import type { OutputMode } from "./BugToPrompt";
import type { ScreenshotMode } from "./session-store";

export interface BugToPromptServerConfig {
	modes?: OutputMode[];
	defaultMode?: OutputMode;
	projectId?: string;
	env?: "dev" | "prod";
	screenshotMode?: ScreenshotMode;
}

/**
 * Resolve the base URL for the bugtoprompt backend.
 *
 * Priority (first truthy wins):
 *   1. `explicit` argument
 *   2. `window.__BUGTOPROMPT__.baseUrl`
 *   3. `<meta name="bugtoprompt-base">` content attribute
 *   4. `""` (same-origin relative — works when the backend is co-hosted)
 *
 * All `window`/`document` accesses are guarded so the function is safe in SSR
 * and jsdom environments.
 */
export function resolveBaseUrl(explicit?: string): string {
	if (explicit) return explicit;

	if (typeof window !== "undefined" && window.__BUGTOPROMPT__?.baseUrl) {
		return window.__BUGTOPROMPT__.baseUrl;
	}

	if (typeof document !== "undefined") {
		const meta = document.querySelector<HTMLMetaElement>(
			'meta[name="bugtoprompt-base"]',
		);
		if (meta?.content) return meta.content;
	}

	return "";
}

/**
 * Fetch server-side configuration from `GET ${base}/bugtoprompt/config`.
 * Returns the parsed JSON on success, `null` on any error (non-ok response,
 * network failure, parse error). Never throws.
 */
export async function fetchServerConfig(
	base: string,
): Promise<BugToPromptServerConfig | null> {
	try {
		const res = await fetch(`${base}/bugtoprompt/config`);
		if (!res.ok) return null;
		return (await res.json()) as BugToPromptServerConfig;
	} catch {
		return null;
	}
}

/**
 * No-backend client for standalone clipboard/download usage.
 *
 * - `saveArtifact` ALWAYS resolves — so `useSession.stop()` completes normally
 *   and the overlay reaches the reviewing phase where clipboard/download work.
 * - `transcribeBatch` resolves with an empty transcript.
 * - `mintStreamingToken` rejects (caught by useSession → degrades to batch).
 * - `listTargets` resolves with an empty array.
 * - `createIssue` rejects — issue mode requires a real backend.
 */
export function createLocalFallbackClient(): BugToPromptClient {
	return {
		mintStreamingToken() {
			return Promise.reject(new Error("streaming token requires a backend"));
		},
		saveArtifact(input) {
			return Promise.resolve({ dir: "", sessionId: input.artifact.sessionId });
		},
		transcribeBatch() {
			return Promise.resolve({ transcript: [] });
		},
		createIssue() {
			return Promise.reject(new Error("issue mode requires a backend"));
		},
		listTargets() {
			return Promise.resolve([]);
		},
	};
}
