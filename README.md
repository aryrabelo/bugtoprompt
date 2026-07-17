# bugtoprompt

[![CI](https://github.com/aryrabelo/bugtoprompt/actions/workflows/ci.yml/badge.svg)](https://github.com/aryrabelo/bugtoprompt/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/bugtoprompt)](https://www.npmjs.com/package/bugtoprompt)

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
backend adds `issue` mode + live transcription.

---

## Use in any project

Three integration paths — pick the one that fits your setup. All three mount
the same overlay and resolve config the same way.

### 1. React import

Install once, drop in anywhere:

```bash
pnpm add bugtoprompt   # react >=18 || >=19 peer
```

```tsx
import { BugToPrompt } from "bugtoprompt";

export function App() {
  return (
    <>
      {/* your app */}
      <BugToPrompt />
    </>
  );
}
```

Zero config required. With nothing set the widget runs fully client-side
(capture → copy/download the prompt). Point it at a backend to unlock issue
mode and live transcription:

```tsx
<BugToPrompt baseUrl="/api" />
```

Config is resolved automatically in this order: `baseUrl` prop →
`window.__BUGTOPROMPT__` → `<meta name="bugtoprompt-base">` → server
`GET {base}/bugtoprompt/config` → local fallback.

The widget self-portals to `<body>` so it never disturbs your layout.

> **Gate the mount on a flag** — the widget has no env checks inside;
> the recommended pattern is to mount it only when a flag is present:
> ```tsx
> {import.meta.env.VITE_BUGTOPROMPT && <BugToPrompt baseUrl="/api" />}
> ```

### 2. Script tag (any page, no build step)

One `<script>` tag works on any page — server-rendered apps, static sites,
or any page you can inspect. Bundles React and ships its own compiled CSS.

```html
<script
  src="https://unpkg.com/bugtoprompt/dist/bugtoprompt.global.js"
  defer
  data-modes="clipboard,download"
></script>
```

Configure via `data-*` attributes:

| Attribute | Prop | Example |
|---|---|---|
| `data-base` | `baseUrl` | `data-base="https://myapp.example.com"` |
| `data-modes` | `modes` | `data-modes="clipboard,download"` |
| `data-project-id` | `projectId` | `data-project-id="repo_abc"` |
| `data-screenshot-mode` | `screenshotMode` | `data-screenshot-mode="onMark"` |
| `data-default-mode` | `defaultMode` | `data-default-mode="clipboard"` |

**Console one-liner** — inject into any page you can inspect:

```js
var s = document.createElement('script');
s.src = 'https://unpkg.com/bugtoprompt/dist/bugtoprompt.global.js';
document.body.appendChild(s);
// optional: pass config programmatically after load
s.addEventListener('load', () => window.BugToPrompt.mount({ modes: ['clipboard'] }));
```

**Programmatic control** — suppress auto-mount and call manually:

```js
window.__BUGTOPROMPT__ = { manual: true };
// load the script, then:
window.BugToPrompt.mount({ baseUrl: 'https://myapp.example.com' });
// later:
window.BugToPrompt.unmount();
```

For live-transcription unlock snippets and the full CORS note, see [docs/console.md](docs/console.md).

### 3. Custom backend

The overlay is fully usable with no backend. Adding one unlocks issue mode
and server-side live transcription.

#### Option A — Run the bundled reference server

The package ships a zero-dependency Node broker that implements the full
`BugToPromptClient` contract:

```bash
node server/github-issue-service.mjs
# or, after publishing:
# ASSEMBLYAI_API_KEY=<key> npx bugtoprompt
```

Key environment variables:

| Variable | Default | Notes |
|---|---|---|
| `ASSEMBLYAI_API_KEY` | — | Required for live transcription |
| `BUGTOPROMPT_PORT` | `4127` | Listen port |
| `BUGTOPROMPT_ENABLE_ISSUES` | `0` | Set `1` to enable GitHub issue filing (needs the `gh` CLI) |
| `BUGTOPROMPT_REPOS` | — | Comma-separated repos exposed as targets |
| `BUGTOPROMPT_ALLOWED_ORIGINS` | — | Comma-separated extra origins (localhost is auto-trusted) |
| `BUGTOPROMPT_TOKEN` | — | Optional shared secret required on every request |

Then point the overlay at it. In a Vite app:

```
VITE_BUGTOPROMPT_BASE_URL=http://localhost:4127
```

```tsx
<BugToPrompt baseUrl={import.meta.env.VITE_BUGTOPROMPT_BASE_URL} />
```

Serve your app over **http** in dev so the page can reach the http broker
without mixed-content blocking.

#### Option B — Implement `BugToPromptClient` yourself

Bring your own transport by implementing the interface from `bugtoprompt/client`:

```ts
import type { BugToPromptClient } from "bugtoprompt/client";

// Implement over any transport (fetch, tRPC, WebSocket, …)
const client: BugToPromptClient = {
  mintStreamingToken: async (targetId?) => ({ token, expiresAt }),
  saveArtifact: async ({ artifact, audioBase64, screenshotsBase64 }) => ({ dir, sessionId }),
  transcribeBatch: async (sessionId, targetId?) => ({ transcript }),
  createIssue: async ({ projectId, targetId, sessionId, prompt }) => ({ created, number, url }),
  listTargets: async (projectId) => [{ id, name, branch }],
};

<BugToPrompt client={client} modes={["issue", "clipboard", "download"]} />
```

`clipboard` and `download` modes are pure client-side and never call the client.
See [The `BugToPromptClient` seam](#the-bugtopromptclient-seam) below for the
full interface and the reference HTTP contract.

---

## Install

```bash
pnpm add bugtoprompt        # peers: react >=18 || >=19, react-dom >=18 || >=19
```

ESM-only. `react` / `react-dom` are peer dependencies; `zod` and `lucide-react`
are bundled dependencies.

## Exports

```ts
import { BugToPrompt, useSession } from "bugtoprompt";                 // the overlay
import { captureArtifactSchema, type CaptureArtifact } from "bugtoprompt/schema";
import { renderPrompt, promptTitle } from "bugtoprompt/render";        // artifact → markdown
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

### Reference HTTP contract (what `createFetchClient` speaks)

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

## Styling (React import path)

The overlay uses **Tailwind** design tokens (`bg-popover`,
`text-muted-foreground`, `bg-primary`, `border-border`, …) supplied by the host
app's theme (the shadcn/ui token set is the reference). Add the package to
Tailwind's content scan so its classes are generated:

```js
content: ["./src/**/*.{ts,tsx}", "./node_modules/bugtoprompt/dist/**/*.js"]
```

The script-tag / console builds bundle their own compiled CSS and do not need
the host's Tailwind.

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
  shown only in `issue` mode when the backend returns targets.

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
pnpm build        # tsup → dist (ESM + .d.ts) for index/schema/render/client
pnpm lint         # biome
```

## Migrating from `bugtoprompt-server`

The standalone `bugtoprompt-server` npm package was discontinued and removed
from npm: its local role was absorbed into the `bugtoprompt` package — the
same sidecar now runs via `npx bugtoprompt`
(entry: `server/github-issue-service.mjs`). The hosted role moved to
[bugtoprompt.com](https://bugtoprompt.com). Update any scripts or docs that
ran `npx`/`bunx bugtoprompt-server` to `npx bugtoprompt`; env vars and
endpoints are unchanged.

## License

MIT
<!-- tl-omp rpc+autocommit e2e 20260717T204957Z -->
