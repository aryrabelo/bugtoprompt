# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Node.js floor raised to `>=22`; CI lanes now run Node 22 + 24.** Node 20
  went EOL in 2026-04 (Node 18 long before), so `engines` in both
  `package.json` and `server/package.json` now require Node 22+. The
  `check:node-compat` guard was retired: `Promise.withResolvers()` (ES2024)
  is natively available on the new floor.
- **Extension popup voice status renamed to `"Ready Local"` / `"Ready Cloud"`.**
  The armed state now names the transcription path directly (local engine vs
  cloud) instead of `"Ready · local · armed"` / `"Ready · armed"`; the manual
  variants keep the same pattern (`"Ready Local · manual"`,
  `"Ready Cloud · manual"`). Owner decision from #9.
- **Migration: `bugtoprompt-server` was absorbed into the `bugtoprompt`
  package.** The local sidecar now runs via `npx bugtoprompt` (same entry,
  `server/github-issue-service.mjs`; env vars and endpoints unchanged). The
  standalone `bugtoprompt-server` npm package was discontinued and removed
  from npm; the hosted role moved to
  [bugtoprompt.com](https://bugtoprompt.com). Docs and snippets
  across the repo were updated accordingly.
- **Extension ↔ sidecar identity finalized (`0.14.0-beta.6`).** The MV3
  extension now consistently targets the local `bugtoprompt` sidecar (auto-
  discovery via `GET /health`, tab-port+3 convention) with zero references to
  the discontinued `bugtoprompt-server` name — locked by a guard test. The
  extension's Vitest suite is now wired into the repo test gate (it previously
  never ran in CI).

## [0.13.2] - 2026-06-29

### Fixed

- **An explicit `baseUrl` now enables backend mode without the config probe.**
  The global build previously adopted the fetch client (issue mode + server
  token minting) only after `GET {base}/bugtoprompt/config` returned 200, so a
  host that set `baseUrl`/`data-base` but didn't implement that optional probe
  silently fell back to clipboard/download and showed the "paste an AssemblyAI
  key" panel. A non-empty resolved base is now treated as proof of a backend;
  the config probe remains optional and is only needed for same-origin
  zero-config discovery (empty base).

## [0.13.1] - 2026-06-26

### Changed

- The collapsed launcher button now reads **BugToPrompt** (was "Snap"), matching
  the open panel's title.

## [0.13.0] - 2026-06-26

### Security

- **Captured input values are no longer stored.** The DOM snapshot previously
  read element `.value` (including `<input type="password">`) into the persisted
  artifact, while only the rendered prompt was redacted — so saved/downloaded
  artifact JSON could contain credentials and PII. Text-entry field values are
  no longer captured; the accessible name comes from labels/placeholders only,
  and `.value` is kept solely for button-like inputs where it is the label.
- **The AssemblyAI key is no longer mirrored onto `window`.** `saveAssemblyKey`
  used to write the key to `window.__BUGTOPROMPT__`, readable by any script on
  the page; the encrypted IndexedDB store is now the only persistence. Reading a
  host-injected window hint key is still supported.

### Fixed

- IndexedDB store collision: the session store and key store shared one
  `bugtoprompt` database with different object stores. They now use separate
  databases (`bugtoprompt-sessions`, `bugtoprompt-keys`).
- Microphone failure no longer leaks the streaming WebSocket — the transcriber
  is stopped when `getUserMedia` fails after the socket opened.
- Screen-capture rehydration no longer leaks a display stream when the overlay
  unmounts while the permission prompt is pending.
- `screenshotMode: "onMark"` no longer triggers a screen-share prompt on record
  start (only `"perPage"` acquires eagerly).
- Replaced `Promise.withResolvers()` (absent in Node 18, which `engines`
  declares) with an internal `deferred()` helper.
- Clipboard copy failures now surface a visible error instead of failing silently.
- `postJson` now includes the server response body in thrown errors.
- Removed a circular import between `autoConfig` and `BugToPrompt`.

### Added

- Accessibility: the panel is now a labelled `role="dialog"`, focus moves to it
  on open, and recording status is announced via an `aria-live` region.
- `ScreenshotMode` is now exported from the package root.
- Route tracking also patches `history.replaceState` (not only `pushState`).

### Changed

- Added lefthook pre-commit hooks (biome + typecheck + test).
- Refactored high cognitive-complexity hotspots with no behavior change:
  `BugToPrompt` split into phase panels + hooks; `useSession` `stop`/`rehydrate`
  decomposed; plus `streaming-auth`, `TargetPicker`, snapshot
  `selector`/`implicitRole`, `key-store`, render `eventRow`, and audio
  `downsample`.

## [0.12.8] - 2026-06-25

### Added

- **Pre-record voice opt-in.** The microphone is no longer requested on Record.
  A "Voice narration" toggle in the idle panel opts in before recording, so
  `getUserMedia` fires only when voice is enabled. New `voiceEnabled` state +
  `enableVoice()` on `useSession`; the `autoVoice` prop seeds the toggle.
- **Text-selection capture.** Mouse-down leaves a placeholder; mouse-up resolves
  it into a `select` event carrying the highlighted text (or a `click`), anchored
  at the mouse-down time and rendered as `selected "…"` in the timeline. New
  `select` kind + `selectedText` on the event schema.
- **Build-version stamp.** The overlay header shows `BugToPrompt v<version>`,
  injected at build time, so a host can confirm which build it is serving.
- **Review timeline.** The review caption interleaves clicks, selections, and
  marks (read-only) with the editable transcript, time-sorted.

### Fixed

- **Live transcription closed on contact (AssemblyAI error 3007).** PCM frames
  were sent one AudioWorklet quantum at a time (~2.7 ms), below the API's
  50–1000 ms-per-message window, so the socket closed before any word. Frames
  are now aggregated to ~100 ms.
- **Transcript lost on stop.** A turn ended mid-utterance (no `end_of_turn`) left
  its words only in the live partial; that trailing partial is now committed on
  stop.
- **Empty batch fallback wiped live captions.** When the socket flagged an error
  at stop, the batch fallback overwrote a good transcript with an empty result.
  It now runs only when no live transcript exists and never adopts an empty one.
- **Transcript timing.** Segments ran on a separate clock starting at 0:00; they
  now use the recording clock and the turn's first-partial time, so an initial
  silence is reflected and speech aligns with click/select events.

## [0.10.0] - 2026-06-16

### Fixed

- **Live transcription now actually connects (v2 → v3).** The client-side
  `assemblyAiKey` mint hit the deprecated `POST api.assemblyai.com/v2/realtime/token`
  endpoint, whose token cannot authenticate the v3 streaming socket the overlay
  opens — so standalone captures silently produced no transcript. It now mints
  via `GET https://streaming.assemblyai.com/v3/token?expires_in_seconds=300`
  (CORS-enabled), matching the v3 socket.

### Added

- **Universal-3 Pro Streaming.** The streaming socket now selects
  `speech_model=u3-rt-pro` for both client- and server-minted sessions.
- **In-overlay API-key prompt.** When no streaming token/key resolves, the
  overlay prompts for an AssemblyAI key ("Enable live transcription") instead of
  silently degrading. The key is persisted client-side
  (`localStorage["bugtoprompt:assemblyai-key"]`, also mirrored to
  `window.__BUGTOPROMPT__.assemblyAiKey`) and applied immediately: because the
  mic is already recording, `useSession.provideKey` attaches live transcription
  mid-capture via the new `AudioCapture.attachLiveTranscription`. `useSession`
  exposes `needsKey` + `provideKey`; the resolver also reads the stored key.
- **`data-assemblyai-key` script attribute** on the standalone build
  pre-provisions the key before mount.

## [0.9.0] - 2026-06-15

### Added

- **Console prod key-unlock.** `resolveStreamingToken` resolves live-transcription
  auth as `window.__BUGTOPROMPT__.streamingToken` → `assemblyAiKey` (mints a
  short-lived AssemblyAI token client-side, per-tab) → `client.mintStreamingToken`
  (server/dev). Lets a developer enable live transcription in production from the
  console without any key endpoint. `docs/console.md` has the snippets.

## [0.8.0] - 2026-06-15

### Added

- **Standalone `<script>` build.** `dist/bugtoprompt.global.js` (IIFE bundling
  React) self-mounts from `data-*` / `window.__BUGTOPROMPT__`; `dist/bugtoprompt.css`
  ships the overlay styles with tokens scoped to `:where([data-bugtoprompt])` as
  `--sp-*`, inlined into the bundle — renders styled on any page with no host
  Tailwind. New exports `./standalone` + `./styles.css`; `example/index.html`.

## [0.7.0] - 2026-06-15

### Added

- **Capture history.** Finished captures (clipboard/download/issue) are saved to a
  local list (`bugtoprompt:history`, cap 50; blobs in IndexedDB). The open panel
  lists them with per-item Copy / Download / Delete (+ File issue in issue mode);
  empty state "No captures yet."

## [0.6.0] - 2026-06-15

### Added

- **Cross-navigation persistence.** A `SessionStore` keeps the in-progress capture
  in `localStorage` (+ IndexedDB for screenshot blobs); the session rehydrates on
  boot so a full-page reload doesn't lose it. `screenshotMode` config
  (`perPage` | `onMark` | `off`, default `onMark`).

## [0.5.1] - 2026-06-15

### Changed

- The **target picker** now shows only in `issue` mode (it is
  host-specific config), and renders nothing when there are no targets — no more
  empty "Select a target…" select on clipboard/download hosts.
- Panel header now reads the brand **"BugToPrompt"** (was "Snap capture").

## [0.5.0] - 2026-06-15

### Added

- **Zero-config drop-in.** `client` is now optional and a new `baseUrl` prop was
  added — `<BugToPrompt />` with no props "just works": it resolves config from
  `baseUrl` → `window.__BUGTOPROMPT__` → `<meta name="bugtoprompt-base">` →
  `GET {base}/bugtoprompt/config`, builds a `createFetchClient` when a backend
  answers, else a local no-backend client (clipboard/download, no secrets).
- `bugtoprompt/client` now also exports `resolveBaseUrl`, `fetchServerConfig`,
  `createLocalFallbackClient`, and `BugToPromptServerConfig` for host reuse.

## [0.4.0] - 2026-06-15

Reconciliation to the authoritative spec (`bugtoprompt`, `<BugToPrompt />`).

### Changed (breaking)

- Renamed the public API: `DebugOverlay` → **`BugToPrompt`**, `DebugClient` →
  **`BugToPromptClient`**, `TargetOption` → **`Target`**; the artifact contract
  drops the "Debug" prefix (`captureArtifactSchema` / `CaptureArtifact` /
  `ARTIFACT_VERSION`). The overlay's data attribute is now `data-bugtoprompt`.
- `BugToPromptClient` method params use `targetId`; `createIssue` now takes the
  rendered `prompt`. `createFetchClient` HTTP paths drop the `/debug` prefix
  (`/streaming-token`, `/artifact`, `/transcribe`, `/issue`, `/targets`).

### Added

- **`bugtoprompt/render`** subpath: `renderPrompt(artifact, opts?)` →
  issue-format markdown, `promptTitle(artifact)`, and `CAPTURE_MARKER_PREFIX`
  (self-contained, React-free, schema-only — usable from a backend).
- **`bugtoprompt/client`** subpath for the client seam.
- **Output modes**: `issue` (default) + `clipboard` + `download`, surfaced in
  the review panel; the default mode is the primary action. Clipboard/download
  are pure client-side (injectable for tests).
- **Route-change auto-snap**: navigation triggers a snap (shares the 600ms
  throttle with click; always on).

### Removed

- The ⌘⇧M keyboard shortcut and the `shortcut/` module. No keyboard shortcut
  ships; snaps come from click, route change, or the Mark button.

## [0.3.0] - 2026-06-15

### Changed

- **Design pass (design-for-ai).** Replaced the glassmorphism snap indication
  with a theme-robust **capture-frame** signature (edge-framed flash, no
  `backdrop-filter`, WCAG-safe on light and dark themes, `ease-out-expo` ~160ms,
  honors `prefers-reduced-motion`). The post-grab ordering invariant is
  preserved.
- Radius harmonization (interactive controls `rounded-sm` nested in the panel),
  inline streaming-health dot, `tabular-nums` recording timer.

### Added

- Accessibility: focus-visible rings on Button/FAB/close, full WAI-ARIA combobox
  wiring (`aria-controls` / `aria-activedescendant` / option ids), error panel
  `role="alert"` with icon.
- Picker: a distinct load-failure state, separate from the empty state.
- Responsive: overlay panel caps at `max-w-[calc(100vw-2rem)]`.

## [0.2.0] - 2026-06-15

### Added

- **Filterable combobox picker** (`TargetPicker`): filter by name/branch,
  keyboard navigation, empty / no-results / selected states; pure `filterTargets`
  helper.
- **Snap on click** (default ON): throttled (~600ms, leading-edge) document-click
  → `mark()`; ignores clicks inside the overlay; ⌘⇧M and the Mark button remain
  manual.
- **Snap shutter**: a brief flash that fires strictly **after** `grab()` resolves
  (never captured in the screenshot), plus a mark-counter pulse.
- **Live caption readability**: auto-scroll to the newest segment, partial vs
  final rendered distinctly, optional `streaming` health badge.

## [0.1.0] - 2026-06-15

### Added

- Initial extraction as a standalone ESM package.
- `overlay/` — the host-agnostic `DebugOverlay` React widget + `useSession`
  capture state machine (audio, snapshot, timeline, caption, shortcut, picker),
  with a dependency-free local `Button` primitive.
- `client/` — the `DebugClient` interface, a reference `createFetchClient`, and
  `blobToBase64`.
- `schema/` — the zod artifact contract (`debugArtifactSchema` et al.) as the
  single source of truth, exported from the `bugtoprompt/schema` subpath.
- tsup build (ESM + `.d.ts`), vitest (jsdom) test suite.

[0.13.2]: https://github.com/aryrabelo/bugtoprompt/releases/tag/v0.13.2
[0.13.1]: https://github.com/aryrabelo/bugtoprompt/releases/tag/v0.13.1
[0.13.0]: https://github.com/aryrabelo/bugtoprompt/releases/tag/v0.13.0
[0.12.8]: https://github.com/aryrabelo/bugtoprompt/releases/tag/v0.12.8
[0.9.0]: https://github.com/
[0.8.0]: https://github.com/
[0.7.0]: https://github.com/
[0.6.0]: https://github.com/
[0.5.1]: https://github.com/
[0.5.0]: https://github.com/
[0.4.0]: https://github.com/
[0.3.0]: https://github.com/
[0.2.0]: https://github.com/
[0.1.0]: https://github.com/
