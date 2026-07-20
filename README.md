# bugtoprompt

[![CI](https://github.com/aryrabelo/bugtoprompt/actions/workflows/ci.yml/badge.svg)](https://github.com/aryrabelo/bugtoprompt/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/bugtoprompt)](https://www.npmjs.com/package/bugtoprompt)

**Capture a bug, get a prompt your AI agent can fix.** bugtoprompt renders a
complete, AI-ready prompt — voice transcript + click timeline + interactive
DOM snapshots + screenshots — in GitHub-issue format. Paste it into
Claude / Cursor / Codex, or file it as an issue.

> ### ⚠️ SUNSET — direct integration is no longer the product
>
> Installing this package into your own app (React import, `<script>` tag, or
> running the bundled `npx` server) is **not supported going forward**. The
> product is the **BugToPrompt Chrome extension**:
>
> - **Lite** (free) — the extension paired with a local Rust tray sidecar
>   (on-device transcription; issues are filed via the `gh` CLI).
> - **Pro** (paid) — the extension talks to the hosted backend at
>   [api.bugtoprompt.com](https://api.bugtoprompt.com); captures land in a
>   cloud inbox and route onward via connectors (GitHub first).
>
> This npm package stays **published** but is sunset for direct
> integration — it is now the internal source the extension and the
> [bugtoprompt.com](https://bugtoprompt.com) landing-page demo are built
> from. The technical docs below describe the overlay as an internal/OSS
> library (still MIT-licensed and buildable from source); they are not an
> install recommendation.

---

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

## Styling

The overlay uses **Tailwind** design tokens (`bg-popover`,
`text-muted-foreground`, `bg-primary`, `border-border`, …) supplied by the host
app's theme (the shadcn/ui token set is the reference). A build consuming the
overlay from source needs the package added to Tailwind's content scan so its
classes are generated:

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
  It authenticates via a short-lived token minted by our backend — the
  customer never holds an AssemblyAI key. Provide the auth one of two ways:
  a **host endpoint that mints a temporary token** (`mintStreamingToken`, via
  `window.__BUGTOPROMPT__` or your `client` — the key stays server-side; the
  path that always works in a plain browser), or a **pre-minted
  `streamingToken`** injected out-of-band. Without either, capture still
  works and the transcript is reconstructed by `transcribeBatch` when a
  backend provides it.
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

## License

MIT
