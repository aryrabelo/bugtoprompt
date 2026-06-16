# snap-prompt — PRD

**Status:** Living product doc · 2026-06-15
**Companion specs:** `docs/activation-persistence-security.md` (activation, persistence, key safety) · windhover extraction spec `2026-06-15-snap-prompt-extraction-design.md` (origin contract)

## 1. What it is

A portable, host-agnostic **bug-capture overlay** that turns a captured bug
(voice transcription, click/route timeline, interactive DOM snapshots,
screenshots) into an **AI-ready prompt in issue format**. Filing a GitHub issue
is the default *output mode*; the value is the captured prompt — where it goes is
pluggable (issue / clipboard / download / custom).

## 2. Product principle — "drop it in and it just works"

A host adds snap-prompt one of four ways and it runs with no further wiring,
self-configuring from whatever context is available and degrading safely when a
backend is absent.

| Path | Summary |
|---|---|
| **React import** | `import { SnapPrompt } from "snap-prompt"` → `<SnapPrompt />`, no required props |
| **Script tag** | `<script src="…/snap-prompt.global.js" defer>` self-mounts (bundles React, ships own CSS) |
| **Console** | Paste a snippet in DevTools — boots on any page, incl. old multi-page apps; unlocks prod (§5) |
| **Chrome extension** *(planned)* | Config + key live in the extension; its content script injects the overlay on allowed origins (§6) |

All paths resolve the **same config** and mount the **same** overlay. Details +
resolution order: `docs/activation-persistence-security.md` §2.

## 3. Output modes

`issue` (default, needs a backend) · `clipboard` · `download` (both pure
client-side, no secrets). The host enables modes via config; the default mode is
the primary action in the review panel.

## 4. Persistence across navigation

Once activated the session persists (`localStorage` for state + IndexedDB for
screenshot blobs) and **keeps capturing across full-page navigations** — it
rehydrates on each page and accumulates one cross-page artifact, cleared on
finish. This is an invariant, not a toggle. Browser constraints (audio/screen
streams can't span a hard reload) are handled per `screenshotMode` config.
Details: `docs/activation-persistence-security.md` §4.

### 4.1 Capture history (the local list of what you made)

On open, the panel is **your list of captures**, not a host-specific "Target"
selector. Every finished capture is saved locally (rendered prompt + artifact +
title/time/page) and listed with per-item actions — **Copy**, **Download**,
**Delete**, and **File issue** when issue mode is enabled — plus **Record** to
start a new one. This is the open-source value: a personal, organized,
client-side history of the bugs you captured. The Windhover-specific "Target"
(worktree) picker is now **issue-mode-only config**, hidden by default (e.g. in
gerarposts there is no target select). Backed by the §4 store.

## 5. Key safety — Dev vs Production

Secret keys (AssemblyAI, GitHub) never reach the browser from a public endpoint.

- **Dev:** the server holds keys and mints short-lived streaming tokens; full
  features.
- **Production:** no key endpoint is exposed. Default is client-side only
  (clipboard/download). Live transcription is unlocked **per developer, per tab**
  via the console (raw key through `prompt()` — documented default — or a
  pre-minted temporary token — hardened option). Details: `…security.md` §3.

## 6. Chrome extension (planned)

A first-class activation path whose purpose is to be the **home for the config
and the key**. Configure once in the extension (base URL, modes,
`screenshotMode`, prod key/token); its content script injects the **same**
`snap-prompt.global.js` + CSS on the origins you allow. The key lives in
extension storage — never in page source, a pasted console snippet, or a public
server. It is the always-on, prod-safe form of the console unlock. This is
packaging over the existing global bundle, not a fork. Build target scheduled
after the script/console paths land. Full design: `…security.md` §7.

## 7. Configurability principle

When a feature's right behavior depends on the host (screenshot strategy, enabled
modes, live-transcription on/off, allowed origins, redaction), it is
**configuration** — settable from any activation path (props, `data-*`,
`window.__SNAP_PROMPT__`, server config, or the extension). The widget hard-codes
only safe defaults.

## 8. Roadmap (build order)

1. **Zero-config React** — optional `client`, auto-config resolver, safe fallback. _(shipped, v0.5.0)_
2. **Persistence** — `SessionStore` (localStorage + IndexedDB); rehydrate on boot; `screenshotMode` config.
3. **Capture history** — local list of finished captures; on open, the panel lists them with per-item Copy / Download / Delete (+ File issue when enabled). Replaces the host-specific "Target" affordance. _(target picker already made issue-mode-only + hidden-when-empty, v0.5.1)_
4. **Standalone script + CSS** — IIFE self-mount; compiled self-contained stylesheet.
5. **Console activation** — one-liner that injects (4); prod key-unlock snippets.
6. **Chrome extension** — package (4) with extension-storage config + content-script injection.
7. **Host adoption** — gerarposts (React import, _live_), then others.
