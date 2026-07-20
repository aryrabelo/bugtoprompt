# bugtoprompt — Activation, Persistence & Key Safety

**Date:** 2026-06-15
**Status:** Proposed design (supersedes the spec §2 non-goal "no `<script>` bundle")

The product principle: **drop it in and it just works.** A host should either
`import { BugToPrompt }` (React) or paste a `<script>` / console snippet, and the
widget runs — pulling config from the server when one is present, degrading to a
pure client-side capture when none is. It must survive full-page navigations and
never leak secret keys in production.

## 1. Four activation paths (all converge on the same overlay)

| Path | How | When |
|---|---|---|
| **React import** | `import { BugToPrompt } from "bugtoprompt"` → `<BugToPrompt />` (no required props) | SPA hosts you control |
| **Script tag** | `<script src="…/bugtoprompt.global.js" defer></script>` (self-mounts) | Any site, incl. server-rendered / "old" multi-page apps |
| **Console** | Paste a one-liner in DevTools → injects the script + boots | Pages you can't edit, or to unlock prod (see §3) |
| **Chrome extension** *(planned)* | Install the extension; its content script injects the overlay on the configured origins | When you want the config + key to live in the extension, not in the page/console — see §7 |

All four resolve the **same config** (§2) and mount the **same** overlay. The
script + console builds bundle React/ReactDOM and ship their **own compiled CSS**
(self-contained tokens) so they render styled on any page without the host's
Tailwind. The React import path uses the host's Tailwind (`@source`).

## 2. Zero-config resolution (no props needed)

On boot the widget resolves, in order:

1. **Explicit** — props (`client`, `baseUrl`, `modes`, …) or `data-*` on the script tag.
2. **Global** — `window.__BUGTOPROMPT__ = { baseUrl?, modes?, projectId?, streamingToken? }` (this is what a console snippet sets — §3).
3. **Meta** — `<meta name="bugtoprompt-base" content="/api">`.
4. **Server config** — `GET {base}/bugtoprompt/config` → `{ modes, defaultMode, projectId }`. The server decides what's enabled.
5. **Safe fallback** — if no backend answers: `modes = ["clipboard","download"]`, a local no-backend client (no secrets, always works).

Result: `<BugToPrompt />` with nothing set still works (capture → copy/download the
AI prompt). A configured backend upgrades it (issue mode, live transcription).

## 3. Key safety — Dev vs Production (the load-bearing rule)

**Secret keys (AssemblyAI, GitHub) never reach the browser from a public server.**

- **Dev Mode** (`{base}/bugtoprompt/config` advertises `env:"dev"`, server holds
  keys): the server mints **short-lived AssemblyAI streaming tokens** and files
  issues. Full features; keys stay server-side. This is the normal path locally.
- **Production** (no key endpoint exposed — by design, to avoid leakage): the
  config endpoint returns `env:"prod"` and does **not** mint tokens. The widget
  defaults to **client-side only** (clipboard/download, no live transcription).
  - **Unlock on demand, via the console:** a developer pastes a snippet that
    supplies a pre-minted **`streamingToken`** for *their own session only*:
    ```js
    // fetches a short-lived token from our backend, then boots
    window.__BUGTOPROMPT__ = { streamingToken: await fetchToken() };
    import("https://…/bugtoprompt.global.js");
    ```
    The widget then opens the AssemblyAI realtime connection using that
    **minted token**. It is the dev's explicit, manual choice — no raw vendor
    key is ever in page source, in a public endpoint, or committed; the
    token is short-lived and lives only in that tab's memory (optionally
    `sessionStorage`, never synced).

Net: prod ships with zero secret exposure; live transcription in prod is an
opt-in, per-developer, console-gated action.

## 4. Persistence across navigation (survive full-page reloads)

Goal: on "old" multi-page sites (each click = full reload) the capture must not
die or break — it keeps recording across pages, then is cleared on finish.

- A **`SessionStore`** persists the in-progress capture: `sessionId`, `startedAt`,
  `binding`, `status:"recording"`, the **event timeline**, **DOM snapshots**, and
  **transcript** → `localStorage` (key `bugtoprompt:session`). Screenshot **blobs**
  go to **IndexedDB** (localStorage's ~5MB cap can't hold images), keyed by
  session+index; localStorage keeps the lightweight index.
- **Rehydrate on every boot:** if an active recording session exists, the widget
  resumes it — re-attaches click/route/mark listeners, restores elapsed from
  `startedAt`, keeps appending. A full-page navigation is invisible to the capture.
- **On finish** (stop → export issue/clipboard/download) the assembled artifact
  spans all pages; then `SessionStore.clear()` wipes localStorage + IndexedDB.

### Hard constraints (browser-imposed, stated honestly)

- **Audio / live transcription cannot span a hard reload** — a `MediaStream` dies
  on unload. If mic permission is already granted for the origin, each page
  re-opens its own mic + AssemblyAI session seamlessly (no re-prompt) and appends
  to the running transcript; otherwise audio is per-page. The event/snapshot/
  transcript timeline still accumulates regardless.
- **Screen capture re-prompts per page** — browsers never persist a
  `getDisplayMedia` grant. So in cross-page (MPA) mode the default snapshot is
  **DOM-only** (interactive snapshot, no screenshot); a screenshot is taken only
  on an explicit Mark (which re-prompts). Within a single SPA page, screenshots
  are automatic as today.

## 5. Build outputs

- `dist/index.js` (+ `/schema`,`/render`,`/client`) — ESM, React-import path (unchanged).
- `dist/bugtoprompt.global.js` — IIFE, bundles React+ReactDOM, self-mounts from
  `data-*` / `window.__BUGTOPROMPT__` / server config.
- `dist/bugtoprompt.css` — compiled, self-contained overlay styles (own tokens),
  auto-injected by the global/console builds.

## 6. Decisions (resolved 2026-06-15)

1. **Prod live-transcription key:** support **both** — ship the raw-key console
   `prompt()` path as the **documented default** (quick, zero-backend, key lives
   only in that tab) and a pre-minted **temporary token** path as the hardened
   option for teams that run a token issuer.
2. **Capture across navigation is config-driven.** Once activated, the session
   lives in `localStorage` and **must keep capturing after a page change** — that
   is the invariant, not a toggle. Where a capability has a UX cost (e.g. the
   screen-share re-prompt), it becomes a **setting**, not a hard-coded choice:
   - `screenshotMode: "perPage" | "onMark" | "off"` — `"perPage"` re-prompts for
     screen share on each page for continuous screenshots (the user's choice; the
     intrusive-but-complete option); `"onMark"` screenshots only on explicit Mark;
     `"off"` keeps DOM-only snapshots (today's "add the local" behavior). Default
     surfaced in config; the host/extension picks.
   - General rule: **when a feature's behavior is in doubt, expose it as config**
     rather than hard-coding (see §7.1).
3. **Persisted blob store:** **IndexedDB** for screenshot blobs + `localStorage`
   for the lightweight session state/index.

## 7. Chrome extension (planned — config + key home)

A first-class activation path where the **config and the key live in the
extension**, not in the page or a pasted console snippet. The extension is the
"always-on, safe-in-prod" form of the console unlock (§3): the developer
configures it once (base URL, modes, `screenshotMode`, and — for prod live
transcription — the AssemblyAI key or a token), and its **content script injects
the overlay** on the origins they allow.

- **Config home:** extension storage (`chrome.storage.local`/`sync`) holds the
  resolved config; it is injected as `window.__BUGTOPROMPT__` before boot, so the
  same zero-config resolver (§2) applies unchanged. No page edits, no console.
- **Key safety:** the key never touches page source or a public server endpoint —
  it lives in the extension and is used client-side only on the dev's machine.
  Strictly better than the console-prompt path for repeated use.
- **Persistence:** the same `localStorage`/IndexedDB session store (§4) lets the
  capture survive navigation; the extension can additionally use its background
  service worker to coordinate across tabs (future).
- **Reuse:** the extension wraps the **same** `bugtoprompt.global.js` + CSS — it
  is packaging, not a fork. Build target added later.

### 7.1 Configurability principle

Features whose right behavior depends on the host (screenshot strategy, which
output modes, whether live transcription is on, allowed origins, redaction
aggressiveness) are **configuration**, resolved by §2 and settable from any
activation path — props, `data-*`, `window.__BUGTOPROMPT__`, server config, or
the extension. The widget hard-codes only safe defaults.
