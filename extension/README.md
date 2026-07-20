# BugToPrompt — Chrome extension (local dev)

Thin MV3 extension that injects the BugToPrompt overlay on `localhost` /
`127.0.0.1` pages. GitHub issues and transcription go through the local
sidecar (the `bugtoprompt` package).

## Install (load unpacked)

Chrome cannot install this automatically — it is a 1-minute manual step:

1. Build once (already done if `dist/` exists): `npm run build:extension`
2. Open `chrome://extensions`
3. Toggle **Developer mode** (top-right)
4. Click **Load unpacked** → select this folder's `dist/` directory
   (`~/Sites/bugtoprompt/extension/dist`)
5. Pin the BugToPrompt icon in the toolbar (puzzle icon → pin)

## Use

- Open any `http://localhost:*` page (e.g. the GerarPosts dev server).
- Click the toolbar icon → popup shows sidecar health, target repo, and
  **Start capture** — or press **⌘⇧Y** to toggle the overlay directly.
- The overlay records numbered clicks (400×600 screenshots when you share
  **This tab**), voice narration, and files GitHub issues via the sidecar.
- On any **non-localhost** site (staging, preview URLs, a bound `owner/repo`
  domain) the popup shows **Enable on this site** first. Clicking it triggers a
  one-time Chrome permission prompt scoped to **that origin only**; capture
  starts once granted. `localhost` / `127.0.0.1` stay zero-config.

## Site permissions (per-site model)

BugToPrompt requests site access at capture time, not install time (issue #97):

- **`host_permissions`** (granted at install, no prompt) is intentionally narrow
  — `localhost`, `127.0.0.1`, and the hosted API only. This is what the Chrome
  Web Store scrutinizes; keeping it narrow avoids the broad-host rejection path.
- **`optional_host_permissions`** declares `http://*/*` + `https://*/*`. These
  are **not** granted at install and produce **no install warning**. Chrome
  requires a matching wildcard scheme here to let the extension request an
  origin it only discovers at runtime
  ([permissions API docs](https://developer.chrome.com/docs/extensions/reference/api/permissions)):
  the popup calls `chrome.permissions.request({ origins: ["https://that.site/*"] })`
  for the exact origin you are on — never a blanket grant.

  The grant is per **host**, not per port: Chrome match patterns have no port
  component, so enabling `https://that.site` covers every port on that host
  (the narrowest unit Chrome can grant).

  For the Web Store "broad host permission" purpose disclosure, the
  justification is: *the extension enables per-site bug capture on arbitrary
  developer/preview hosts the user chooses, each granted individually via a
  runtime prompt.* The wildcard is the mechanism for that runtime prompt, not a
  standing grant. `manifest`/`optional_host_permissions` are pinned by
  `src/permissions.test.ts` so neither half drifts.

## Requirements

- The sidecar must be running for issues/voice: it starts automatically with
  `bun run dev` in GerarPosts, or standalone via `npx bugtoprompt`
  (see `../server/`). On macOS, install the local Lite tray app instead —
  [download the latest `BugToPrompt.dmg`](https://github.com/aryrabelo/bugtoprompt/releases/latest/download/BugToPrompt.dmg)
  (always the newest stable release; see `sidecar-tray/`).
- Options page: sidecar URL (loopback only) and screenshot mode.
- Issue filing is opt-in on the sidecar: set `BUGTOPROMPT_ENABLE_ISSUES=1`
  (needs an authenticated `gh` CLI). Voice transcription runs locally when
  `parakeet-mlx` is available, otherwise it needs `ASSEMBLYAI_API_KEY`.

## Update after code changes

`npm run build:extension`, then on `chrome://extensions` hit the ↻ reload
button on the BugToPrompt card. `npm run pack:extension` produces the
distributable zip.
