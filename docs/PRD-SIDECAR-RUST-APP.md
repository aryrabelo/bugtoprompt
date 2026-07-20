# PRD: BugToPrompt Desktop Sidecar (Rust)

**Status:** Partially shipped — see status note below.
**Date:** 2026-07-15 (drafted); status note added 2026-07-20
**Owner:** Ary Rabelo

## 1. Summary

Replace the Node.js LaunchAgent sidecar (`bugtoprompt-server` on port 4127)
with a cross-platform Rust desktop app that lives in the system tray / menu
bar. The app serves the same HTTP API the Chrome extension already expects,
adds a settings UI, and eliminates the Node.js dependency for end users.

**v1:** macOS (menu bar / NSStatusItem)
**v2:** Windows (system tray / NotifyIcon)


## 0. Status note (2026-07-20)

Two pieces of this draft already shipped, exactly as designed:

- **Lite has zero AssemblyAI exposure.** `/streaming-token` and cloud-transcribe
  paths in the sidecar are permanently stubbed to `501`, pointing callers at
  cloud mode (`sidecar-rust/src/handlers.rs`) — issue #119 / PR #126.
- **No customer bring-your-own AssemblyAI key, anywhere.** The overlay's
  client-side key store and in-app key prompt were removed; live transcription
  authenticates solely via a token minted by our backend — issue #125 / PR #127.

**One architectural detail below is now stale:** §4's diagram, §6's "Token
flow" bullet, and §7's Pro ascii block describe the Rust sidecar **proxying**
Pro requests to the hosted backend. That is not what shipped. The extension's
service worker (`extension/src/background.ts` — `PRO_OPS`, `executeProOp`)
relays every Pro operation (`mintStreamingToken`, `saveArtifact`,
`transcribeBatch`, `createIssue`, `listTargets`) **directly** to
`PRO_BASE_URL` (`https://api.bugtoprompt.com`) with a `Bearer <proToken>`
header — confirmed by `extension/src/background.test.ts` asserting the exact
request URL. The local sidecar is never in the Pro request path; it only
serves Lite/local operations. Corrected inline below (§4, §6, §7).
---

## 2. Problem

Current installation requires:
1. Install Node.js
2. `npm i -g bugtoprompt-server`
3. Configure env vars (API keys, origins, project ID, repos)
4. Manually create a LaunchAgent plist (macOS) or scheduled task (Windows)

This is a **non-starter for non-developers**. The extension cannot function
without a backend for issue filing and transcription, and the setup friction
kills adoption.

---

## 3. Tiers

| Feature | Lite (Free) | Pro (Paid) |
|---|---|---|
| Overlay capture (clicks, screenshots) | Client-side, always free | Same |
| Clipboard / Download output | Always free | Same |
| **Transcription: local engine** | Yes (Parakeet-MLX via uvx) | Yes |
| **Transcription: AssemblyAI cloud** | No | Yes |
| **GitHub issue filing** | Via local `gh` CLI (requires install) | Via hosted backend (no `gh` needed) |
| **Hosted backend proxy** | No | Yes (api.bugtoprompt.com) |
| Configurable project limit | 1 | Unlimited |

### Pro mixing model

A Pro user can **mix and match** (design intent — see §6's "known gap" for
shipped-vs-designed status of the local/cloud picker):
- **Transcription:** local engine (sidecar) OR AssemblyAI cloud — a paid
  feature served via a backend-minted token; there is no customer AssemblyAI
  key entry
- **Issue filing:** ALWAYS via hosted backend (no local `gh` CLI needed)

This means a Pro user gets value from the sidecar (fast local transcription)
while offloading GitHub auth/filing to the hosted API.

### Lite model

A Lite user runs **everything locally**:
- Local transcription (Parakeet-MLX, fetched via uvx on first use)
- `gh` CLI subprocess for issue filing (must be installed separately)
- No hosted backend dependency

---

## 4. Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Chrome Extension (existing, unchanged)                      │
│    overlay.tsx → captures bug → artifact JSON                │
│                                                                │
│    LITE path — local ops only, gated on sidecar health:      │
│    background.ts → fetch http://127.0.0.1:4127/*             │
│         ├─ /health → 200? → use local sidecar                │
│         └─ /health → ECONNREFUSED? → show "Download app"     │
│                                                                │
│    PRO path — always direct to the hosted backend, NEVER      │
│    through the sidecar (background.ts PRO_OPS/executeProOp): │
│    background.ts → fetch https://api.bugtoprompt.com/*        │
│         (Bearer <proToken> from chrome.storage.local; gated   │
│          only on proToken presence, independent of sidecar    │
│          health — a Pro user with no sidecar running still    │
│          gets cloud transcription + hosted issue filing)      │
│                                                              │
│  Rust Sidecar App (new — replaces Node server)               │
│  ┌────────────────────────────────────────────────────┐      │
│  │  HTTP Server (axum) on 127.0.0.1:4127 — LITE ONLY  │      │
│  │    GET  /health          → gh state + transcribe   │      │
│  │    GET  /bugtoprompt/config → modes + projectId    │      │
│  │    GET  /targets          → configured repos       │      │
│  │    POST /artifact         → persist JSON+audio+png │      │
│  │    POST /transcribe       → uvx parakeet-mlx only   │      │
│  │    POST /streaming-token  → always 501 (no cloud   │      │
│  │                            relay; use PRO path)     │      │
│  │    POST /issue            → gh CLI (Lite only —    │      │
│  │                            Pro never reaches this)  │      │
│  │                                                    │      │
│  │  Transcription Engine                               │      │
│  │    Parakeet-MLX via uvx (local, Apple Silicon)    │      │
│  │    — no AssemblyAI anywhere in this process        │      │
│  │                                                    │      │
│  │  Settings Window (Tauri webview)                    │      │
│  │    - GitHub token                                  │      │
│  │    - Allowed origins                               │      │
│  │    - Project/repo config                           │      │
│  │    - Tier: Lite / Pro (login to activate Pro)      │      │
│  │                                                    │      │
│  │  System Tray / Menu Bar                            │      │
│  │    🐛 BugToPrompt  ● Running (port 4127)           │      │
│  │      → Settings                                    │      │
│  │      → Open logs                                   │      │
│  │      → Quit                                        │      │
│  └────────────────────────────────────────────────────┘      │
│                                                              │
│  Hosted Backend (existing — api.bugtoprompt.com) — PRO ONLY, │
│  reached DIRECTLY by the extension, never via the sidecar     │
│    - Pro auth (Bearer proToken subscription check)            │
│    - GitHub issue filing (token on server)                    │
│    - AssemblyAI streaming token minting (server-side key)     │
└──────────────────────────────────────────────────────────────┘
```

---

## 5. HTTP API Contract (unchanged from Node server)

The Rust app must serve the **exact same API** the extension already calls.
No extension changes required.

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | `{ ok, issues, repos, gh, transcription, originAllowed }` |
| GET | `/bugtoprompt/config` | Advertised modes + projectId + defaultMode |
| GET | `/targets?projectId=...` | Configured repos as `Target[]` |
| POST | `/artifact` | Persist artifact.json + audio + screenshots |
| POST | `/transcribe` | Batch transcript — local Parakeet-MLX only (no cloud path in the sidecar) |
| POST | `/streaming-token` | Always `501` — cloud transcription never relays through the sidecar; Pro mints directly against the hosted backend (see §0) |
| POST | `/issue` | `gh issue create`, Lite only — Pro issue filing bypasses the sidecar entirely (see §0) |

All endpoints bind to `127.0.0.1` only. CORS enforced via
`Access-Control-Allow-Origin` matching configured allowed origins.

---

## 6. Transcription

### Local (Lite + Pro)

- **Engine:** Parakeet-MLX via `uvx` subprocess (already in production — see
  `server/local-transcribe.mjs`). Rust sidecar spawns `uvx parakeet-mlx` the
  same way the Node server does today.
- **Dependency:** Requires `uv`/`uvx` installed on the user's machine.
  The sidecar's `/health` endpoint probes for `uvx` availability and reports
  `transcription: "local"` (ready) or `"unconfigured"` (missing).
- **First-run:** If `uvx` is missing, the settings UI shows a one-click
  install prompt (`curl -LsSf https://astral.sh/uv/install.sh | sh`) with
  a progress indicator. Parakeet-MLX downloads automatically on first
  transcription via uvx's lazy fetch.
- **Hardware:** Apple Silicon only (Metal/GPU via MLX framework).
  Windows v2 will need a different local engine (see Implementation Notes #3).
- **Offline:** After first transcription, Parakeet-MLX is cached locally.

> ⚠️ **Dependency note:** The Rust sidecar eliminates the Node.js dependency,
> but local transcription still requires `uv`/`uvx` (Python runner). This is
> acceptable because: (1) `uv` is a single 15MB binary, far lighter than
> Node.js, (2) it's only needed for local transcription — Pro cloud users
> don't need it, (3) the install flow is automated in the settings UI.

### Cloud (Pro only)

- **Engine:** AssemblyAI streaming API — server-side only, never customer-facing.
- **Token flow:** the extension mints a short-lived streaming token **directly**
  against the hosted backend (`POST https://api.bugtoprompt.com/streaming-token`,
  `Bearer <proToken>`) — the sidecar is never in this path (see §0).
- **Batch fallback:** same direct-to-hosted-backend path, not `POST /transcribe`
  on the sidecar (that endpoint is local-only, see §5).
- **Engine selection — known gap:** §3's "Pro mixing model" and §13 decision #5
  describe a per-session/settings local-vs-cloud picker. The shipped Settings
  UI does not have one yet — `sidecar-tray/settings.html`'s `#engine` `<select>`
  currently offers only `<option value="local">Local (Parakeet via uvx)</option>`,
  no cloud option. In practice: the sidecar always offers local Parakeet
  (tier-agnostic — it doesn't check `tier` before serving `/transcribe`); cloud
  transcription is whatever the extension's overlay resolves automatically for
  a Pro session (§0), not a manual choice in this settings window. Flagged as a
  Deferred item in `.context/handoff.md` — settings-UI cloud toggle is
  unimplemented, not merely undocumented.

---

## 7. GitHub Issue Filing

### Lite path (local `gh` CLI)

```
Extension → POST /issue → sidecar spawns `gh issue create` subprocess
                              → requires gh installed + authenticated
```

### Pro path (direct to hosted backend, bypasses the sidecar)

```
Extension (background.ts PRO_OPS/executeProOp)
  → POST https://api.bugtoprompt.com/issue, Bearer <proToken>
      → server holds GitHub token
      → no local gh needed, no sidecar involved
```

Routing is decided **client-side in the extension**, not by the sidecar:
- Lite (no `proToken`): always local `gh` via the sidecar.
- Pro (`proToken` present): always the direct hosted relay — see §0.

---

## 8. Settings UI

Tauri webview window (opens from tray icon click). **Mockup only** — the
"Transcription" fieldset below shows a `[Local Parakeet ▼] / [Cloud (Pro)]`
picker that hasn't shipped: `sidecar-tray/settings.html`'s `#engine`
`<select>` currently offers only `local` (see §6 "known gap").

```
┌─ BugToPrompt Settings ──────────────────────────┐
│                                                 │
│  ● Sidecar running on 127.0.0.1:4127           │
│                                                 │
│  ┌─ Account ─────────────────────────────────┐  │
│  │  Tier: [Lite ▼]  [Login to Pro →]        │  │
│  │  Email: aryrabelo@...                    │  │
│  └───────────────────────────────────────────┘  │
│  ┌─ Transcription ───────────────────────────┐  │
│  │  Engine: [Local Parakeet ▼] / [Cloud (Pro)] │  │
│  │  uvx status: ✓ ready                       │  │
│  │  Cloud: auto (backend-minted token, Pro)  │  │
│  └───────────────────────────────────────────┘  │
│                                                 │
│  ┌─ GitHub ──────────────────────────────────┐  │
│  │  Mode: [Hosted (Pro) ▼] / [Local gh CLI]  │  │
│  │  Repos: gerarposts, bugtoprompt           │  │
│  └───────────────────────────────────────────┘  │
│                                                 │
│  ┌─ Security ────────────────────────────────┐  │
│  │  Allowed origins:                         │  │
│  │  [https://gerarposts.com.br         ✕]   │  │
│  │  [http://localhost:3000             ✕]   │  │
│  │  [+ Add origin]                           │  │
│  └───────────────────────────────────────────┘  │
│                                                 │
│  [Save]                          [Quit App]     │
└─────────────────────────────────────────────────┘
```

---

## 9. Extension Auto-Detection Flow

The extension's `background.ts` already calls `/health` on page load. The
enhanced flow:

```
1. Extension loads on localhost:3000
2. background.ts fetches http://127.0.0.1:4127/health
3. If 200 → use sidecar (existing behavior, unchanged)
4. If ECONNREFUSED:
   a. Check chrome.storage for Pro credentials
   b. If Pro → fetch api.bugtoprompt.com/health
      → If 200: use hosted backend directly
      → If fail: show "Pro backend unavailable"
   c. If no Pro → show banner:
      "BugToPrompt app not detected.
       [Download for macOS] [Connect to Pro →]"
```

**Note (2026-07-20):** step 4's framing ("Pro user with no sidecar → hosted
backend") is the ORIGINAL 2026-07-15 design. What shipped is stricter: Pro
routing (`PRO_OPS`/`executeProOp`) is gated only on `proToken` presence, not
on `/health` failing first — a Pro user's cloud transcription and hosted issue
filing go direct regardless of whether the sidecar is even installed. See §0.

---

## 10. Distribution

### Binary

- **macOS:** `.dmg` → drag to `/Applications`
  - Notarized + signed (Developer ID)
  - Universal binary (arm64 + x86_64)
  - App size target: < 20 MB (Rust binary only, no model bundled — Parakeet fetched via uvx)
- **Windows (v2):** `.msi` installer via Tauri bundler
  - System tray icon
  - Auto-start on login

### Auto-update

- Tauri updater plugin checks GitHub releases
- Downloads + applies in background
- Prompts on next tray interaction

---

## 11. Tech Stack

| Layer | Technology | Why |
|---|---|---|
| HTTP server | `axum` | Async, tower middleware, typed routes |
| Transcription | `std::process::Command` → `uvx parakeet-mlx` | Existing engine, same as current Node sidecar |
| Tray icon | `tray-icon` crate | Cross-platform (macOS + Windows from day 1) |
| Settings UI | Tauri webview | HTML/CSS/JS in a window, no Electron bloat |
| Config store | TOML or SQLite | `~/.config/bugtoprompt/config.toml` |
| GitHub (Lite) | `std::process::Command` | Spawn `gh issue create` subprocess |
| GitHub (Pro) | — | N/A in the sidecar. The extension relays Pro `createIssue` directly to the hosted backend (see §0); the sidecar's `reqwest` usage is Lite-only (local `/health`/config probes). |
| AssemblyAI | — | N/A in the sidecar (see §0). Server-side only, reached directly by the extension for Pro. |
| Logging | `tracing` | Structured async logging |

---

## 12. Non-Goals (v1)

- Linux support (v3+)
- Multiple simultaneous project profiles (v2)
- Browser extension changes (extension stays as-is, auto-detection is
  additive and falls back gracefully)
- Bundling Parakeet-MLX model in the app (uvx fetches on first use)

---

## 13. Decisions (Resolved)

| # | Decision | Rationale |
|---|---|---|
| 1 | **Engine: Parakeet-MLX via uvx** (not Whisper) | Already in production in `local-transcribe.mjs`. MLX is Apple Silicon native. |
| 2 | **No model bundling** | uvx lazily fetches parakeet-mlx on first transcription. Keeps app binary < 20 MB. |
| 3 | **Lite = no registration** | Client-side capture is free. No server cost for Lite users. Signup wall kills "30-second try". |
| 4 | **Pro = registration + payment** | Pro uses hosted backend resources (GitHub proxy, AssemblyAI). Paywall justified. |
| 5 | **Pro can mix transcription modes (design intent, not yet shipped)** | Pro user is meant to choose local (Parakeet) OR cloud (AssemblyAI) per-session or in settings; the settings UI ships with local-only today — see §6 "known gap". |
| 6 | **Anonymous telemetry on Lite** | `anonId` (uuid v4) + event tracking (installed, capture_started, modes used). No PII. |
| 7 | **Telemetry tied to account on Pro** | Same events but linked to user account for DAU/MAU + conversion tracking. |

---

## 14. Implementation Notes

1. **uvx dependency:** Already handled in current sidecar. `/health` probes
   `uvx` with a 5s timeout (`LOCAL_ENGINE_PROBE_TIMEOUT_MS`). If missing,
   settings UI shows one-click install link. No bundling needed.

2. **Pro auth:** `proToken` lives in the extension's `chrome.storage.local`
   (never synced), not in the sidecar's `config.toml`. The sidecar's own
   `tier`/`email` config fields (`sidecar-rust/src/config.rs`) are informational
   display state for the Settings UI only — they do not gate any sidecar route;
   Pro routing is decided entirely client-side in the extension (see §0).

3. **Windows transcription (v2):** Parakeet-MLX is Apple Silicon only.
   Windows port will use whisper.cpp or AssemblyAI-only. Decide at v2 kickoff.

4. **Config migration:** On first run, the app reads the existing LaunchAgent
   plist env vars (`BUGTOPROMPT_*`, `ASSEMBLYAI_API_KEY`, `BUGTOPROMPT_REPOS`)
   and imports them into `config.toml`. One-time migration.

---

## 15. Telemetry Plan

### Events (anonymous on Lite, linked to account on Pro)

```
installed        → { anonId, version, platform }
capture_started  → { anonId, origin }
capture_completed → { anonId, mode (clipboard|download|issue), durationMs }
transcribe_used  → { anonId, engine (local|cloud), durationMs }
issue_filed      → { anonId, via (local-gh|hosted), repoCount }
upgrade_clicked  → { anonId, from (banner|settings|health-fail) }
```
**No PII captured.** No page URLs, no bug content, no transcript text.
Sent to `api.bugtoprompt.com/telemetry` (batched, best-effort).

### Upsell banner in extension popup (Lite only)

```
┌───────────────────────────────┐
│  Bug captured ✓               │
│  [Copy] [Download]            │
│                               │
│  💡 Want AI issue filing?     │
│     No CLI needed.            │
│     [Upgrade to Pro →]        │
└───────────────────────────────┘
```

---

## 16. Success Metrics

| Metric | Target |
|---|---|
| App size | < 20 MB (Rust binary, no model) |
| Memory at idle | < 15 MB (vs 49 MB current Node sidecar) |
| Memory during transcription | < 50 MB sidecar (Parakeet runs as separate uvx process) |
| First-run setup time | < 30 seconds (download + open + auto-detect) |
| Extension detection success | 100% (health check within 2s of app start) |
| Lite → Pro conversion | Track via telemetry funnel |
