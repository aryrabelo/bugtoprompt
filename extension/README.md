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
  **Start capture** — or press **⌘⇧B** to toggle the overlay directly.
- The overlay records numbered clicks (400×600 screenshots when you share
  **This tab**), voice narration, and files GitHub issues via the sidecar.

## Requirements

- The sidecar must be running for issues/voice: it starts automatically with
  `bun run dev` in GerarPosts, or standalone via `npx bugtoprompt`
  (see `../server/`).
- Options page: sidecar URL (loopback only) and screenshot mode.

## Update after code changes

`npm run build:extension`, then on `chrome://extensions` hit the ↻ reload
button on the BugToPrompt card. `npm run pack:extension` produces the
distributable zip.
