/**
 * Global augmentations — window.__BUGTOPROMPT__ host configuration hint.
 * Consumed by autoConfig.ts to resolve the backend base URL and initial modes
 * without requiring an explicit `baseUrl` prop.
 *
 * Also declares window.BugToPrompt for the standalone IIFE build.
 */
declare global {
	interface Window {
		__BUGTOPROMPT__?: {
			/** Base URL of the bugtoprompt backend (e.g. "https://myapp.example.com"). */
			baseUrl?: string;
			/** Output modes to surface; overridden by server config when available. */
			modes?: ("issue" | "clipboard" | "download")[];
			/** Default output action. */
			defaultMode?: "issue" | "clipboard" | "download";
			/** Default project to scope issue filing. */
			projectId?: string;
			/** AssemblyAI API key for client-side streaming transcription. */
			assemblyAiKey?: string;
			/** Pre-minted streaming token (avoids a round-trip on first record). */
			streamingToken?: string;
			/** Host-provided async token minter (e.g. an extension background
			 *  worker). Tried before the in-browser key mint; bypasses page CORS. */
			mintStreamingToken?: () => Promise<string>;
			/** Screenshot strategy. "onClick" captures every eligible page click
			 *  (local-development default); "perPage" re-prompts per navigation;
			 *  "onMark" screenshots only on explicit Mark; "off" DOM-only snapshots. */
			screenshotMode?: "onClick" | "perPage" | "onMark" | "off";
			/** Default state of the pre-record Voice narration toggle. When true,
			 *  voice narration is pre-armed at recording start (user can still
			 *  change it before recording). Default: false. */
			autoVoice?: boolean;
			/** Open the capture panel immediately on mount (extension activation
			 *  feedback) instead of only the floating launcher. Default: false. */
			defaultOpen?: boolean;
			/** When true, the standalone build will NOT auto-mount on load.
			 *  Call window.BugToPrompt.mount() manually instead. */
			manual?: boolean;
		};
		/** Exposed by the standalone IIFE build (bugtoprompt.global.js). */
		BugToPrompt?: {
			mount: (opts?: Record<string, unknown>) => () => void;
			unmount: () => void;
		};
	}
}

export {};
