# snap-prompt

A portable, host-agnostic **bug-capture overlay** — a floating, Loom-style
recorder you drop onto any web app. It captures a bug (live voice transcription,
click timeline, interactive DOM snapshots, screenshots) and turns it into an
**AI-ready prompt in issue format**. Where that prompt goes is up to you:

- **`issue`** — file a GitHub issue (needs a backend)
- **`clipboard`** — copy the rendered prompt
- **`download`** — save a `.md` prompt + the artifact JSON

The widget's product is **capturing a bug well and rendering it as a prompt**.
With no backend it runs fully client-side (clipboard/download); a configured
backend adds `issue` mode + live transcription. Config is resolved automatically
(zero-config) or via an optional injected `SnapPromptClient`.

> Extracted from windhover-desktop, which is now one consumer among others.

## Install

```bash
pnpm add snap-prompt        # peers: react >=19, react-dom >=19
```

ESM-only. `react` / `react-dom` are peer dependencies; `zod` and `lucide-react`
are dependencies.

## Quick start (zero-config)

```tsx
import { SnapPrompt } from "snap-prompt";

export function App() {
  return (
    <>
      {/* your app */}
      <SnapPrompt /> {/* drop it in — it just works */}
    </>
  );
}
```

With nothing configured, `<SnapPrompt />` runs fully client-side (capture →
**copy**/**download** the prompt — no backend, no secrets). It self-portals to
`<body>` so it never disturbs your layout, and resolves config automatically:
`baseUrl` prop → `window.__SNAP_PROMPT__` → `<meta name="snap-prompt-base">` →
a server `GET {base}/snap-prompt/config`. A reachable backend upgrades it
(issue mode, live transcription).

### With a backend

```tsx
import { SnapPrompt } from "snap-prompt";
import { createFetchClient } from "snap-prompt/client";

// auto-detect modes/targets from the server:
<SnapPrompt baseUrl="/api" />

// or take full control with an explicit client:
<SnapPrompt
  client={createFetchClient("/api")}
  projectId={repoId}
  modes={["issue", "clipboard", "download"]}
  defaultMode="issue"
/>
```

The Windhover-style **target picker** shows only in `issue` mode (and only when
the backend returns targets); clipboard/download hosts see just **Record**.

### Recommended: gate the mount on an env flag

The widget **does not self-gate** — it has no env checks inside. The recommended
pattern is for the host to mount it only when a flag is present, and let each
developer decide:

```tsx
{import.meta.env.VITE_SNAP_PROMPT && <SnapPrompt client={client} /* … */ />}
```

### Styling

The overlay uses **Tailwind** design tokens (`bg-popover`,
`text-muted-foreground`, `bg-primary`, `border-border`, …) supplied by your
app's theme (the shadcn/ui token set is the reference). Add the package to
Tailwind's content scan so its classes are generated:

```js
content: ["./src/**/*.{ts,tsx}", "./node_modules/snap-prompt/dist/**/*.js"]
```

### Script tag (any page)

No React, no Tailwind, no build step needed. One `<script>` tag renders the
fully-styled widget on any page — including server-rendered / old multi-page apps.

```html
<script
  src="https://unpkg.com/snap-prompt/dist/snap-prompt.global.js"
  defer
  data-modes="clipboard,download"
></script>
```

Config via `data-*` attributes:
| Attribute | Prop mapped | Example |
|---|---|---|
| `data-base` | `baseUrl` | `data-base="https://myapp.example.com"` |
| `data-modes` | `modes` | `data-modes="clipboard,download"` |
| `data-project-id` | `projectId` | `data-project-id="repo_abc"` |
| `data-screenshot-mode` | `screenshotMode` | `data-screenshot-mode="onMark"` |
| `data-default-mode` | `defaultMode` | `data-default-mode="clipboard"` |

**Console one-liner** (inject into any page you can inspect):
```js
var s = document.createElement('script');
s.src = 'https://unpkg.com/snap-prompt/dist/snap-prompt.global.js';
document.body.appendChild(s);
// optional: pass config programmatically after the script loads
s.addEventListener('load', () => window.SnapPrompt.mount({ modes: ['clipboard'] }));
```

**Programmatic control** — suppress auto-mount and call manually:
```js
window.__SNAP_PROMPT__ = { manual: true };
// … load the script, then:
window.SnapPrompt.mount({ baseUrl: 'https://myapp.example.com' });
// later:
window.SnapPrompt.unmount();
```

For live-transcription unlock snippets (assemblyAiKey / streamingToken) and the full CORS note, see [docs/console.md](docs/console.md).

## Exports

```ts
import { SnapPrompt, useSession } from "snap-prompt";                 // the overlay
import { captureArtifactSchema, type CaptureArtifact } from "snap-prompt/schema";
import { renderPrompt, promptTitle } from "snap-prompt/render";       // artifact -> markdown
import { createFetchClient, type SnapPromptClient } from "snap-prompt/client";
```

- `snap-prompt/render` and `snap-prompt/schema` are **React-free** — safe to
  import in a backend (Node/Bun) that validates artifacts or renders the prompt.

## The `SnapPromptClient` seam

The overlay needs exactly one thing from its host: a `SnapPromptClient`. Use the
bundled `createFetchClient(baseUrl)` (HTTP) or implement the interface directly
over your own transport:

```ts
import type { SnapPromptClient } from "snap-prompt/client";

interface SnapPromptClient {
  mintStreamingToken(targetId?: string): Promise<{ token: string; expiresAt: number }>;
  saveArtifact(input: {
    artifact: CaptureArtifact;
    audioBase64: string;
    screenshotsBase64: string[];
  }): Promise<{ dir: string; sessionId: string }>;
  transcribeBatch(sessionId: string, targetId?: string): Promise<{ transcript: CaptureArtifact["transcript"] }>;
  createIssue(input: { projectId: string; targetId?: string; sessionId: string; prompt: string }): Promise<{ created: boolean; number: number; url: string }>;
  listTargets(projectId: string): Promise<Target[]>; // Target = { id, name, branch }
}
```

`createIssue` receives the rendered `prompt` (the issue body). `clipboard` and
`download` modes are pure client-side and never touch the client.

### Reference HTTP contract (`issue` mode, what `createFetchClient` speaks)

| Method | Request | Response |
|---|---|---|
| `mintStreamingToken` | `POST {base}/streaming-token` `{ targetId? }` | `{ token, expiresAt }` |
| `saveArtifact` | `POST {base}/artifact` `{ artifact, audioBase64, screenshotsBase64 }` | `{ dir, sessionId }` |
| `transcribeBatch` | `POST {base}/transcribe` `{ sessionId, targetId? }` | `{ transcript }` |
| `createIssue` | `POST {base}/issue` `{ projectId, targetId?, sessionId, prompt }` | `{ created, number, url }` |
| `listTargets` | `GET {base}/targets?projectId=<id>` | `Target[]` |

All POSTs send `Content-Type: application/json`; non-2xx throws.

## The artifact schema & prompt renderer

```ts
import { captureArtifactSchema, ARTIFACT_VERSION, type CaptureArtifact } from "snap-prompt/schema";
import { renderPrompt, promptTitle, CAPTURE_MARKER_PREFIX } from "snap-prompt/render";

const artifact = captureArtifactSchema.parse(raw);   // validate (backend)
const body = renderPrompt(artifact, { artifactDir }); // issue-format markdown
const title = promptTitle(artifact);
```

`renderPrompt` is the canonical prompt body shared by every mode and by your
backend. Bump `ARTIFACT_VERSION` only on a breaking shape change; pin a
compatible package version on the consumer's backend.

## Capture behavior

- **Snap triggers**: **click** (default ON; a "Snap on click" toggle turns it
  off; clicks inside the overlay are ignored; throttled ~1 per 600ms) and
  **route change** (auto-snap on SPA navigation, always on, same throttle), plus
  a manual **Mark** button. **No keyboard shortcut.**
- **Snap indication**: a brief edge **capture-frame** flash that fires *after*
  the screenshot grab resolves (so it never lands in the captured pixels).
  Honors `prefers-reduced-motion`.
- **Live caption**: streaming transcription over AssemblyAI **Universal-3 Pro**
  (`speech_model=u3-rt-pro`) shows interim partials distinctly from finals and
  auto-scrolls; falls back to batch transcription on stop.
- **Target picker**: a filterable combobox (name/branch filter, keyboard nav)
  when the host can't infer the binding.

## Host requirements

- **Live transcription** uses AssemblyAI
  [Universal-3 Pro Streaming](https://www.assemblyai.com/docs/streaming/universal-3-pro).
  Provide the auth one of three ways: a host endpoint that mints a temporary
  token (`mintStreamingToken`, key stays server-side); a client-side
  `assemblyAiKey` (minted in-browser against the CORS-enabled v3 token endpoint,
  key never leaves the tab); or — when neither is configured — the overlay
  **prompts the user for a key** and persists it locally. Without any of these,
  capture still works and the transcript is reconstructed by `transcribeBatch`
  when a backend provides it.
- **Screenshots** use `getDisplayMedia`; **audio** uses `getUserMedia`. On macOS
  desktop hosts (Tauri/Electron), grant **Microphone** and **Screen Recording**
  permissions/entitlements.

## Development

```bash
pnpm install
pnpm test         # vitest (jsdom)
pnpm build        # tsup -> dist (ESM + .d.ts) for index/schema/render/client
pnpm lint         # biome
```

## License

MIT
