# bugtoprompt

**Capture a bug, get a prompt your AI agent can fix.** bugtoprompt is a
drop-in, host-agnostic overlay: hit record, narrate and click through the bug,
and it renders a complete, AI-ready prompt — voice transcript + click timeline +
interactive DOM snapshots + screenshots — in GitHub-issue format. Paste it into
Claude / Cursor / Codex, or file it as an issue.

**See it in 30 seconds.** Try it with no build step: open `example/index.html`
(it injects the standalone widget via one script tag), click the bug button,
record, and copy the prompt.

Where the prompt goes is up to you:

- **`issue`** — file a GitHub issue (needs a backend)
- **`clipboard`** — copy the rendered prompt
- **`download`** — save a `.md` prompt + the artifact JSON

It runs fully client-side with no backend (clipboard/download); a configured
backend adds `issue` mode + live transcription. Config is resolved automatically
(zero-config) or via an optional injected `BugToPromptClient`.

## Install

```bash
pnpm add bugtoprompt        # peers: react >=19, react-dom >=19
```

ESM-only. `react` / `react-dom` are peer dependencies; `zod` and `lucide-react`
are dependencies.

## Quick start (zero-config)

```tsx
import { BugToPrompt } from "bugtoprompt";

export function App() {
  return (
    <>
      {/* your app */}
      <BugToPrompt /> {/* drop it in — it just works */}
    </>
  );
}
```

With nothing configured, `<BugToPrompt />` runs fully client-side (capture →
**copy**/**download** the prompt — no backend, no secrets). It self-portals to
`<body>` so it never disturbs your layout, and resolves config automatically:
`baseUrl` prop → `window.__BUGTOPROMPT__` → `<meta name="bugtoprompt-base">` →
a server `GET {base}/bugtoprompt/config`. A reachable backend upgrades it
(issue mode, live transcription).

### With a backend

```tsx
import { BugToPrompt } from "bugtoprompt";
import { createFetchClient } from "bugtoprompt/client";

// auto-detect modes/targets from the server:
<BugToPrompt baseUrl="/api" />

// or take full control with an explicit client:
<BugToPrompt
  client={createFetchClient("/api")}
  projectId={repoId}
  modes={["issue", "clipboard", "download"]}
  defaultMode="issue"
/>
```

The **target picker** shows only in `issue` mode (and only when
the backend returns targets); clipboard/download hosts see just **Record**.

### Local transcription broker (self-hosted)

Live voice transcription needs a backend to mint short-lived AssemblyAI tokens —
the API key stays server-side and never reaches the browser. Run the bundled
broker with no install:

```bash
ASSEMBLYAI_API_KEY=<your-key> bunx bugtoprompt-server   # http://localhost:4127
```

Point the overlay at it (Vite example):

```
VITE_BUGTOPROMPT_BASE_URL=http://localhost:4127
```

The overlay calls `GET /bugtoprompt/config` (this `200` activates backend mode)
and `POST /streaming-token` (mints the token); the browser then opens AssemblyAI's
WebSocket directly. Serve your app over **http** in dev so it can reach the http
broker without mixed-content blocking. The broker also serves `/transcribe`,
`/artifact`, `/targets`, and `/issue` (issue mode needs `BUGTOPROMPT_ENABLE_ISSUES=1`
plus the `gh` CLI).

### Recommended: gate the mount on an env flag

The widget **does not self-gate** — it has no env checks inside. The recommended
pattern is for the host to mount it only when a flag is present, and let each
developer decide:

```tsx
{import.meta.env.VITE_BUGTOPROMPT && <BugToPrompt client={client} /* … */ />}
```

### Styling

The overlay uses **Tailwind** design tokens (`bg-popover`,
`text-muted-foreground`, `bg-primary`, `border-border`, …) supplied by your
app's theme (the shadcn/ui token set is the reference). Add the package to
Tailwind's content scan so its classes are generated:

```js
content: ["./src/**/*.{ts,tsx}", "./node_modules/bugtoprompt/dist/**/*.js"]
```

### Script tag (any page)

No React, no Tailwind, no build step needed. One `<script>` tag renders the
fully-styled widget on any page — including server-rendered / old multi-page apps.

```html
<script
  src="https://unpkg.com/bugtoprompt/dist/bugtoprompt.global.js"
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
s.src = 'https://unpkg.com/bugtoprompt/dist/bugtoprompt.global.js';
document.body.appendChild(s);
// optional: pass config programmatically after the script loads
s.addEventListener('load', () => window.BugToPrompt.mount({ modes: ['clipboard'] }));
```

**Programmatic control** — suppress auto-mount and call manually:
```js
window.__BUGTOPROMPT__ = { manual: true };
// … load the script, then:
window.BugToPrompt.mount({ baseUrl: 'https://myapp.example.com' });
// later:
window.BugToPrompt.unmount();
```

For live-transcription unlock snippets (assemblyAiKey / streamingToken) and the full CORS note, see [docs/console.md](docs/console.md).

## Exports

```ts
import { BugToPrompt, useSession } from "bugtoprompt";                 // the overlay
import { captureArtifactSchema, type CaptureArtifact } from "bugtoprompt/schema";
import { renderPrompt, promptTitle } from "bugtoprompt/render";       // artifact -> markdown
import { createFetchClient, type BugToPromptClient } from "bugtoprompt/client";
```

- `bugtoprompt/render` and `bugtoprompt/schema` are **React-free** — safe to
  import in a backend (Node/Bun) that validates artifacts or renders the prompt.

## The `BugToPromptClient` seam

The overlay needs exactly one thing from its host: a `BugToPromptClient`. Use the
bundled `createFetchClient(baseUrl)` (HTTP) or implement the interface directly
over your own transport:

```ts
import type { BugToPromptClient } from "bugtoprompt/client";

interface BugToPromptClient {
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
import { captureArtifactSchema, ARTIFACT_VERSION, type CaptureArtifact } from "bugtoprompt/schema";
import { renderPrompt, promptTitle, CAPTURE_MARKER_PREFIX } from "bugtoprompt/render";

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
  Provide the auth one of three ways, in order of reliability: a **host endpoint
  that mints a temporary token** (`mintStreamingToken`, via `window.__BUGTOPROMPT__`
  or your `client` — the key stays server-side; the path that always works in a
  plain browser); a **pre-minted `streamingToken`** injected out-of-band; or a
  client-side **`assemblyAiKey`** — note AssemblyAI's v3 token endpoint does **not**
  allow browser CORS (preflight returns 405), so this in-browser mint only succeeds
  behind a CORS-permitting proxy and otherwise falls through silently. When none is
  configured the overlay **prompts the user for a key** and persists it locally.
  Without any of these, capture still works and the transcript is reconstructed by
  `transcribeBatch` when a backend provides it. The streaming WebSocket itself is
  not CORS-restricted — only the token mint is.
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
