# bugtoprompt — Activation, Persistence & Key Safety

**Date:** 2026-07-20
**Status:** Current — extension-first v2 model.
**Supersedes:** the 2026-06-15 multi-path design (React import as a general
install path / `<script>` tag / DevTools console) described in an earlier
revision of this doc. That design is dead — see the README
[sunset notice](../README.md#L11-L28) and `docs/console.md` (retired). This
revision documents what actually ships today; the old text is preserved in
git history for reference.

The product principle is unchanged: **drop it in and it just works.** What
changed is the *how*: there is exactly one activation path now — the
**BugToPrompt Chrome extension** — and exactly one key model: AssemblyAI is
**our** server-side vendor, never a customer-facing key surface.

## 1. Activation — the Chrome extension is the only path

| Path | Status |
|---|---|
| **Chrome extension** | **Current.** MV3 extension injects the overlay; see §1.1. |
| React import (`import { BugToPrompt } from "bugtoprompt"`) | Design-history. Sunset for direct integration (README §sunset); the package stays published only as the internal build source for the extension and the bugtoprompt.com landing-page demo — not an install recommendation. |
| Script tag (`<script src="…/bugtoprompt.global.js">`) | Design-history. Same sunset. |
| Console snippet (paste in DevTools) | **Retired**, see [`docs/console.md`](console.md). |

### 1.1 How the extension activates the overlay

- `extension/manifest.json` + the MV3 service worker
  (`extension/src/background.ts`) own per-tab activation state and inject the
  same packaged bundle the old script-tag path used
  (`bugtoprompt.global.js` + its self-contained CSS) — this is packaging over
  the existing global build, not a fork.
- **Loopback is zero-config:** `localhost` / `127.0.0.1` are always
  activatable, no permission prompt (`extension/src/config.ts` —
  `isSupportedUrl`, `classifyPage`).
- **Any other origin needs a one-time, per-origin runtime grant:** the popup
  shows **Enable on this site**; clicking it calls
  `chrome.permissions.request({ origins: [...] })` scoped to exactly that
  origin (`extension/src/config.ts` — `originPattern`; see
  `extension/README.md` §"Site permissions" for the full Chrome Web Store
  rationale, issue #97). `host_permissions` at install time stays narrow
  (loopback + the hosted API only); the broad-origin ability is
  `optional_host_permissions`, granted per-site at runtime, never as a
  standing install-time grant.
- **Re-injection on navigation:** a lightweight ISOLATED-world content script
  (`extension/src/content.ts`, localhost only) pings the service worker on
  every fresh document; the service worker reinjects the bundle and remounts
  the overlay for a tab that was active (`background.ts` —
  `handleDocumentReady`). A full-page reload is invisible to the user — see
  §3 for how the in-progress capture itself survives it.

## 2. Zero-config resolution (unchanged mechanism, new source)

The overlay's config resolver is the same one that used to read `data-*` /
`window.__BUGTOPROMPT__` from a script tag or console snippet. What changed
is *who sets it*:

1. The extension reads its own config from `chrome.storage.sync`
   (`extension/src/config.ts` — `loadConfig`, `SyncConfig`: base URL, site→repo
   bindings, `screenshotMode`, …).
2. Before injecting the bundle, it seeds `window.__BUGTOPROMPT__` with that
   config (`background.ts` — `seedConfig`, `injectBundle`).
3. The bundle boots and resolves config exactly as before: explicit
   `window.__BUGTOPROMPT__` first, then server config
   (`GET {base}/bugtoprompt/config`), then a safe fallback
   (`modes = ["clipboard","download"]`, no backend, no secrets).

**Backend discovery (Lite):** the extension probes local-sidecar candidates
in order and uses the first one whose `GET /health` answers `ok:true`
(`extension/src/config.ts` — `candidateBaseUrls`, `discoverBaseUrl`).

**Backend discovery (Pro):** Pro does **not** go through the local sidecar.
See §3.2 — the extension talks directly to the hosted backend.

## 3. Key safety — the load-bearing rule

**AssemblyAI is our server-side vendor. It is never a customer-facing key
surface — no client-side key, no console `prompt()`, no `data-assemblyai-key`
attribute, no `window.__BUGTOPROMPT__.assemblyAiKey`.** That entire
bring-your-own-key path existed in an earlier design and was **removed**
(issue #125, PR #127) — do not re-introduce it in code or in docs.

### 3.1 Lite (free) — local only, no AssemblyAI at all

- Transcription: **local Parakeet-MLX only**, run by the Rust tray sidecar
  via `uvx`. The sidecar's cloud-transcription and `/streaming-token`
  handlers are permanently stubbed to `501`, pointing the caller at cloud
  mode instead (`sidecar-rust/src/handlers.rs`) — AssemblyAI does not exist
  anywhere in the Lite sidecar (issue #119, PR #126).
- Issue filing: the sidecar shells out to the user's own authenticated `gh`
  CLI (`sidecar-rust/src/handlers.rs` — `POST /issue`).
- No hosted-backend dependency, no key of any kind leaves the user's machine.

### 3.2 Pro (paid) — cloud transcription via a backend-minted token

- The customer never holds, pastes, or stores an AssemblyAI key. Ever.
- Live transcription authenticates via a **short-lived streaming token
  minted by our backend** (`mintStreamingToken` / `streamingToken`) —
  resolution order in the overlay: a pre-minted token → a host-provided
  minter → `client.mintStreamingToken()` (`src/overlay/streaming-auth.ts`).
  No raw vendor key is ever in page source, a public endpoint, or a console
  snippet.
- The extension resolves this **directly against the hosted backend**
  (`https://api.bugtoprompt.com`), not through the local sidecar: all Pro
  operations — `mintStreamingToken`, `saveArtifact`, `transcribeBatch`,
  `createIssue`, `listTargets` — are relayed by the service worker with a
  `Bearer <proToken>` header built from `PRO_BASE_URL` + a fixed path
  (`extension/src/background.ts` — `PRO_OPS`, `executeProOp`). `proToken`
  lives in `chrome.storage.local` only, never synced.
- Issue filing on Pro goes through the same direct relay (hosted GitHub
  proxy) — no local `gh` needed.

### 3.3 What was removed (do not re-introduce)

- Client-side AssemblyAI key storage / `key-store.ts` (deleted).
- The in-overlay "paste your AssemblyAI key" prompt / `KeyPrompt` component
  (deleted).
- `data-assemblyai-key` on a script tag; `window.__BUGTOPROMPT__.assemblyAiKey`.
- Any framing of AssemblyAI access as "user choice" between raw-key and
  token — there is no raw-key option anymore, only the minted token.

Net: Lite ships with zero AssemblyAI exposure of any kind; Pro's live
transcription is a paid, backend-brokered feature with zero secret exposure
to the customer.

## 4. Persistence across navigation (survive full-page reloads)

This mechanism is unchanged from the original design and is still real —
only the trigger for "boot" changed (extension reinjection instead of a
script tag re-executing, see §1.1).

- A **`SessionStore`** persists the in-progress capture: `sessionId`,
  `startedAt`, `binding`, `status:"recording"`, the **event timeline**,
  **DOM snapshots**, and **transcript** → `localStorage` (key
  `bugtoprompt:session`). Screenshot **blobs** go to **IndexedDB**
  (`localStorage`'s ~5MB cap can't hold images), keyed by session+index;
  `localStorage` keeps the lightweight index
  (`src/overlay/session-store.ts`).
- **Rehydrate on every reinjection:** if an active recording session exists,
  the widget resumes it — re-attaches click/route/mark listeners, restores
  elapsed from `startedAt`, keeps appending
  (`src/overlay/useSession.ts` — `rehydrateSession`). A full-page navigation
  is invisible to the capture.
- **On finish** (stop → export issue/clipboard/download) the assembled
  artifact spans all pages; then the store is cleared (`localStorage` +
  IndexedDB).

### Hard constraints (browser-imposed, stated honestly — unchanged)

- **Audio / live transcription cannot span a hard reload** — a `MediaStream`
  dies on unload. If mic permission is already granted for the origin, each
  page re-opens its own mic + transcription session seamlessly (no
  re-prompt) and appends to the running transcript; otherwise audio is
  per-page. The event/snapshot/transcript timeline still accumulates
  regardless.
- **Screen capture re-prompts per page** — browsers never persist a
  `getDisplayMedia` grant. Screenshot behavior is config-driven via
  `screenshotMode`:
  - `"onClick"` — automatic screenshot on every click, within a single page
    (today's SPA default).
  - `"perPage"` — re-prompts for screen share on each page for continuous
    screenshots (the intrusive-but-complete option).
  - `"onMark"` — screenshots only on an explicit Mark (which re-prompts).
  - `"off"` — DOM-only interactive snapshots, no screenshot at all.

  (`extension/src/config.ts` — `ScreenshotMode`.)

## 5. Build outputs

- `dist/index.js` (+ `/schema`, `/render`, `/client`) — ESM, React-import
  path. Still built and published, but **design-history for installation** —
  it's the extension's and the landing-page demo's internal build source, per
  the README sunset notice. Not an install recommendation.
- `dist/bugtoprompt.global.js` — IIFE, bundles React+ReactDOM, self-mounts
  from `window.__BUGTOPROMPT__`. This is what the extension injects.
- `dist/bugtoprompt.css` — compiled, self-contained overlay styles (own
  design tokens), auto-injected alongside the global bundle.

## 6. Decisions (resolved)

| # | Decision | Date | Ref |
|---|---|---|---|
| 1 | Distribution collapses to the Chrome extension only; React import / script tag / `npx` server sunset for direct integration, package kept published as internal build source. | 2026-06-15 → shipped | README sunset notice, `docs/console.md` (#101/PR #118) |
| 2 | Customer bring-your-own AssemblyAI key surface removed entirely (client-side key store, `data-assemblyai-key`, `window.__BUGTOPROMPT__.assemblyAiKey`, in-overlay key prompt). | 2026-07-20 | #125 / PR #127 |
| 3 | Lite sidecar drops AssemblyAI entirely — local Parakeet-MLX only; cloud-transcribe/`streaming-token` handlers permanently stub `501`. | 2026-07-20 | #119 / PR #126 |
| 4 | Pro live transcription authenticates solely via a backend-minted short-lived token; the extension relays Pro ops directly to `api.bugtoprompt.com`, bypassing the local sidecar. | 2026-07-20 | #125 / PR #127 |
| 5 | Capture across navigation stays config-driven (unchanged from the original design): once activated, the session lives in `localStorage`/IndexedDB and keeps capturing after a page change — an invariant, not a toggle. `screenshotMode` is the escape hatch for the screen-share UX cost. | 2026-06-15 | original design, still in force |
| 6 | Persisted blob store: IndexedDB for screenshot blobs + `localStorage` for the lightweight session state/index. | 2026-06-15 | original design, still in force |

## 7. Configurability principle

Features whose right behavior depends on the host (screenshot strategy,
which output modes, allowed origins, redaction) are **configuration**,
resolved by §2 and settable from the extension's own storage (options page,
popup, `chrome.storage.sync`) — never from page source, a pasted snippet, or
a hard-coded default. The widget itself hard-codes only safe fallbacks.
