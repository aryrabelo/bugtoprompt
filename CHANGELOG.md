# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
  (`localStorage["snap-prompt:assemblyai-key"]`, also mirrored to
  `window.__SNAP_PROMPT__.assemblyAiKey`) and applied immediately: because the
  mic is already recording, `useSession.provideKey` attaches live transcription
  mid-capture via the new `AudioCapture.attachLiveTranscription`. `useSession`
  exposes `needsKey` + `provideKey`; the resolver also reads the stored key.
- **`data-assemblyai-key` script attribute** on the standalone build
  pre-provisions the key before mount.

## [0.9.0] - 2026-06-15

### Added

- **Console prod key-unlock.** `resolveStreamingToken` resolves live-transcription
  auth as `window.__SNAP_PROMPT__.streamingToken` → `assemblyAiKey` (mints a
  short-lived AssemblyAI token client-side, per-tab) → `client.mintStreamingToken`
  (server/dev). Lets a developer enable live transcription in production from the
  console without any key endpoint. `docs/console.md` has the snippets.

## [0.8.0] - 2026-06-15

### Added

- **Standalone `<script>` build.** `dist/snap-prompt.global.js` (IIFE bundling
  React) self-mounts from `data-*` / `window.__SNAP_PROMPT__`; `dist/snap-prompt.css`
  ships the overlay styles with tokens scoped to `:where([data-snap-prompt])` as
  `--sp-*`, inlined into the bundle — renders styled on any page with no host
  Tailwind. New exports `./standalone` + `./styles.css`; `example/index.html`.

## [0.7.0] - 2026-06-15

### Added

- **Capture history.** Finished captures (clipboard/download/issue) are saved to a
  local list (`snap-prompt:history`, cap 50; blobs in IndexedDB). The open panel
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

- The Windhover-style **target picker** now shows only in `issue` mode (it is
  host-specific config), and renders nothing when there are no targets — no more
  empty "Select a target…" select on clipboard/download hosts.
- Panel header now reads the brand **"Snap Prompt"** (was "Snap capture").

## [0.5.0] - 2026-06-15

### Added

- **Zero-config drop-in.** `client` is now optional and a new `baseUrl` prop was
  added — `<SnapPrompt />` with no props "just works": it resolves config from
  `baseUrl` → `window.__SNAP_PROMPT__` → `<meta name="snap-prompt-base">` →
  `GET {base}/snap-prompt/config`, builds a `createFetchClient` when a backend
  answers, else a local no-backend client (clipboard/download, no secrets).
- `snap-prompt/client` now also exports `resolveBaseUrl`, `fetchServerConfig`,
  `createLocalFallbackClient`, and `SnapPromptServerConfig` for host reuse.

## [0.4.0] - 2026-06-15

Reconciliation to the authoritative spec (`snap-prompt`, `<SnapPrompt />`).

### Changed (breaking)

- Renamed the public API: `DebugOverlay` → **`SnapPrompt`**, `DebugClient` →
  **`SnapPromptClient`**, `TargetOption` → **`Target`**; the artifact contract
  drops the "Debug" prefix (`captureArtifactSchema` / `CaptureArtifact` /
  `ARTIFACT_VERSION`). The overlay's data attribute is now `data-snap-prompt`.
- `SnapPromptClient` method params use `targetId`; `createIssue` now takes the
  rendered `prompt`. `createFetchClient` HTTP paths drop the `/debug` prefix
  (`/streaming-token`, `/artifact`, `/transcribe`, `/issue`, `/targets`).

### Added

- **`snap-prompt/render`** subpath: `renderPrompt(artifact, opts?)` →
  issue-format markdown, `promptTitle(artifact)`, and `CAPTURE_MARKER_PREFIX`
  (self-contained, React-free, schema-only — usable from a backend).
- **`snap-prompt/client`** subpath for the client seam.
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

- Initial extraction from windhover-desktop as a standalone ESM package.
- `overlay/` — the host-agnostic `DebugOverlay` React widget + `useSession`
  capture state machine (audio, snapshot, timeline, caption, shortcut, picker),
  with a dependency-free local `Button` primitive.
- `client/` — the `DebugClient` interface, a reference `createFetchClient`, and
  `blobToBase64`.
- `schema/` — the zod artifact contract (`debugArtifactSchema` et al.) as the
  single source of truth, exported from the `snap-prompt/schema` subpath.
- tsup build (ESM + `.d.ts`), vitest (jsdom) test suite.

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
