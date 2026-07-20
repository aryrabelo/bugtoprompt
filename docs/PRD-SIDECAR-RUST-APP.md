# PRD: BugToPrompt Desktop Sidecar (Rust)

**Status:** Draft
**Date:** 2026-07-15
**Owner:** Ary Rabelo

## 1. Summary

Replace the Node.js LaunchAgent sidecar (`bugtoprompt-server` on port 4127)
with a cross-platform Rust desktop app that lives in the system tray / menu
bar. The app serves the same HTTP API the Chrome extension already expects,
adds a settings UI, and eliminates the Node.js dependency for end users.

**v1:** macOS (menu bar / NSStatusItem)
**v2:** Windows (system tray / NotifyIcon)

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

A Pro user can **mix and match**:
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
│    background.ts → fetch http://127.0.0.1:4127/*             │
│         │                                                    │
│         ├─ /health → 200? → use local sidecar                │
│         └─ /health → ECONNREFUSED? →                         │
│              ├─ Pro user? → try api.bugtoprompt.com           │
│              └─ Lite user? → show "Download BugToPrompt app" │
│                                                              │
│  Rust Sidecar App (new — replaces Node server)               │
│  ┌────────────────────────────────────────────────────┐      │
│  │  HTTP Server (axum) on 127.0.0.1:4127              │      │
│  │    GET  /health          → gh state + transcribe   │      │
│  │    GET  /bugtoprompt/config → modes + projectId    │      │
│  │    GET  /targets          → configured repos       │      │
│  │    POST /artifact         → persist JSON+audio+png │      │
│  │    POST /transcribe       → uvx parakeet-mlx OR     │      │
│  │                            → AssemblyAI cloud       │      │
│  │    POST /streaming-token  → AssemblyAI temp token  │      │
│  │    POST /issue            → gh CLI (Lite) OR proxy │      │
│  │                            → hosted API (Pro)      │      │
│  │                                                    │      │
│  │  Transcription Engine                               │      │
│  │    Parakeet-MLX via uvx (local, Apple Silicon)    │      │
│  │    OR AssemblyAI HTTP (Pro only)                   │      │
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
│  Hosted Backend (existing — api.bugtoprompt.com)             │
│    - Pro auth (subscription check)                           │
│    - GitHub issue filing proxy (token on server)             │
│    - AssemblyAI proxy (server-side key)                      │
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
| POST | `/transcribe` | Batch transcript (local Parakeet-MLX or AssemblyAI) |
| POST | `/streaming-token` | AssemblyAI temp token (Pro only) |
| POST | `/issue` | `gh issue create` (Lite) or proxy to hosted (Pro) |

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

- **Engine:** AssemblyAI streaming API
- **Token flow:** sidecar mints temp token via hosted backend → passes to
  extension for live streaming
- **Batch fallback:** `POST /transcribe` with AssemblyAI REST API
- **User choice:** Pro users select local OR cloud per-session or in settings

---

## 7. GitHub Issue Filing

### Lite path (local `gh` CLI)

```
Extension → POST /issue → sidecar spawns `gh issue create` subprocess
                              → requires gh installed + authenticated
```

### Pro path (hosted backend proxy)

```
Extension → POST /issue → sidecar proxies to api.bugtoprompt.com
                              → server holds GitHub token
                              → no local gh needed
```

The sidecar decides which path based on tier:
- Lite: always local `gh`
- Pro: always hosted (unless explicitly overridden in settings)

---

## 8. Settings UI

Tauri webview window (opens from tray icon click):

```
┌─ BugToPrompt Settings ──────────────────────────┐
│                                                 │
│  ● Sidecar running on 127.0.0.1:4127           │
│                                                 │
│  ┌─ Account ─────────────────────────────────┐  │
│  │  Tier: [Lite ▼]  [Login to Pro →]        │  │
│  │  Email: aryrabelo@...                    │  │
│  └───────────────────────────────────────────┘  │
│                                                 │
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
| GitHub (Pro) | `reqwest` | HTTP POST to hosted backend |
| AssemblyAI | `reqwest` | Streaming + REST API |
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
| 5 | **Pro can mix transcription modes** | Pro user chooses local (Parakeet) OR cloud (AssemblyAI) per-session or in settings. |
| 6 | **Anonymous telemetry on Lite** | `anonId` (uuid v4) + event tracking (installed, capture_started, modes used). No PII. |
| 7 | **Telemetry tied to account on Pro** | Same events but linked to user account for DAU/MAU + conversion tracking. |

---

## 14. Implementation Notes

1. **uvx dependency:** Already handled in current sidecar. `/health` probes
   `uvx` with a 5s timeout (`LOCAL_ENGINE_PROBE_TIMEOUT_MS`). If missing,
   settings UI shows one-click install link. No bundling needed.

2. **Pro auth:** Login token stored in `~/.config/bugtoprompt/config.toml`.
   Extension reads tier from sidecar `/health` response.

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
