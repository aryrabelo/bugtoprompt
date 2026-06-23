# BugToPrompt — Wave 1 Design (local self-hosted broker)

- **Date:** 2026-06-23
- **Status:** Approved — ready for implementation plan
- **Scope:** Wave 1 only. Waves 2–4 summarized under "Out of scope".
- **Primary deliverable:** voice transcription works end-to-end in the
  `gerarposts` app (`~/Sites/gerarposts`) run locally (`bun dev`), with the
  backend served by a **standalone, host-agnostic broker** run via
  `bunx bugtoprompt-server` — no backend changes to gerarposts.

---

## 1. Problem

The BugToPrompt overlay shows **"No transcript yet."** after recording. Root
cause (confirmed in code): the overlay only switches from its empty
local-fallback client to the real backend client when
`GET ${base}/bugtoprompt/config` returns `200`
(`bugtoprompt/src/overlay/BugToPrompt.tsx:191-203`). With no backend the overlay
stays on `createLocalFallbackClient()`, whose `transcribeBatch()` resolves to
`{ transcript: [] }` and whose `mintStreamingToken()` rejects
(`bugtoprompt/src/overlay/autoConfig.ts:75-93`). Audio, clicks, DOM snapshots,
and screenshots are all captured — only the transcript is empty.

`gerarposts` already depends on `bugtoprompt@^0.10.0` and mounts the overlay
client-only and dev-on (`gerarposts/apps/web/src/components/bugtoprompt-mount.tsx`,
`__root.tsx:18,93`), reading an optional `VITE_BUGTOPROMPT_BASE_URL`. The only
missing piece is a backend serving the BugToPromptClient contract.

## 2. Key decision — standalone broker, not embedded routes

A standalone broker is cleaner than embedding routes in each host app:
host-agnostic (the bugtoprompt identity), reusable by any local app, keeps the
AssemblyAI key in one place, and requires **zero backend changes to gerarposts**.

**The broker already exists and is complete.**
`bugtoprompt/scripts/github-issue-service.mjs` already serves the full contract
(line refs from the file header + dispatch):

- `GET  /bugtoprompt/config` (`:601`) — the `200` gate that activates the client
- `POST /streaming-token` (`:617`) — mint a 300s AssemblyAI streaming token
- `POST /transcribe` (`:613`) — AssemblyAI batch transcript
- `POST /artifact` (`:609`), `GET /targets` (`:605`), `POST /issue` (`:621`)

It has **zero external runtime dependencies** — only `node:` builtins plus two
local files (`service-security.mjs`, `transcript-segments.mjs`). It already binds
`127.0.0.1`, applies an origin allowlist that auto-trusts localhost origins
(`service-security.mjs` `isOriginAllowed`), and validates sessionIds against path
traversal.

**Packaging decision:** publish it as an npm package exposing a
`bugtoprompt-server` bin, run with **`bunx bugtoprompt-server`** (no install;
requires `bun`/`node` present — acceptable, the audience is developers). No
rewrite. Rust/Python were considered and rejected: Rust means rewriting the whole
contract (tapa-rs `commands.rs:146` only covers the mint); Python distributes
poorly for an "installable app".

## 3. Architecture

```
Terminal: bunx bugtoprompt-server                (the broker process)
  env: ASSEMBLYAI_API_KEY (required, server-only)
       PORT=4127 (default), BUGTOPROMPT_ALLOWED_ORIGINS (optional)
  serves http://localhost:4127
    GET  /bugtoprompt/config   -> 200 { modes, projectId?, defaultMode? }
    POST /streaming-token      -> { token, expiresAt }   (key never leaves here)
    POST /transcribe, /artifact, /issue, GET /targets

gerarposts (run via `bun dev`, overlay already mounted, dev-on)
  VITE_BUGTOPROMPT_BASE_URL=http://localhost:4127
  overlay: resolveBaseUrl -> fetchServerConfig GET .../bugtoprompt/config (200 gate)
           -> createFetchClient(base)
           record -> mintStreamingToken() POST .../streaming-token -> { token }
           -> StreamingTranscriber opens wss://streaming.assemblyai.com (direct)
           -> live transcript -> rendered prompt
```

Security boundary: the raw `ASSEMBLYAI_API_KEY` lives only inside the broker
process. The browser only ever receives the 300s ephemeral token; the streaming
WebSocket runs browser→AssemblyAI directly (CORS-exempt).

## 4. Wave 1 — Local dogfood in gerarposts

### 4.1 Package the broker as `bugtoprompt-server`
- Add a CLI entry wrapping `scripts/github-issue-service.mjs`: shebang
  (`#!/usr/bin/env node`), a `bin` mapping the command name `bugtoprompt-server`,
  and ensure `scripts/*.mjs` (broker + `service-security.mjs` +
  `transcript-segments.mjs`) are included in the package `files`.
- Recommended for clean `bunx bugtoprompt-server` resolution: a package **named**
  `bugtoprompt-server` (a dedicated thin package re-exporting the broker), or a
  bin of that exact name. Exact packaging is an implementation-plan detail.
- Config via env/flags: `ASSEMBLYAI_API_KEY` (required), `PORT` (default 4127),
  `BUGTOPROMPT_ALLOWED_ORIGINS` (optional; localhost auto-trusted),
  `BUGTOPROMPT_TOKEN` (optional shared secret), `GITHUB_TOKEN`/`gh` (only for
  issue mode — not needed for transcription).

### 4.2 Immediate dogfood (before publishing)
- Run today without packaging:
  `ASSEMBLYAI_API_KEY=... bun scripts/github-issue-service.mjs`
  (Bun 1.3.14 confirmed; the file uses only `node:` builtins.)

### 4.3 Point gerarposts at the broker
- Set `VITE_BUGTOPROMPT_BASE_URL=http://localhost:4127` in gerarposts
  (`apps/web` env). No gerarposts backend routes, no gerarposts secret — the key
  lives in the broker.
- Overlay is already mounted and dev-on; nothing else to wire.

### 4.4 Acceptance
- Start the broker; `bun dev` gerarposts → overlay visible → record voice →
  live transcript appears → generated prompt contains the transcript.
  "No transcript yet." gone on the happy path.

## 5. Production note (explicitly out of Wave 1)

A localhost broker cannot serve `gerarposts.com.br` (a public site cannot call a
developer's machine). Therefore the previously discussed **konami / 6-digit
unlock** prod activation does **not** belong to Wave 1 — it requires either a
small host-embedded route in gerarposts or the hosted bugtoprompt.com (Wave 4).
When built, the secure design stands: 6-digit code held in server env
(`BUGTOPROMPT_UNLOCK_CODE`, never `VITE_`-prefixed), verified server-side with a
constant-time compare, rate-limited + lockout (10^6 space is brute-forceable
without it), success issues a short-lived HMAC-signed `httpOnly; Secure;
SameSite=Strict` cookie that `/streaming-token` requires. Deferred.

## 6. Out of scope (later waves)
- **Wave 2:** Web Speech API native transcriber (tier-0, no backend) with an OFF
  fallback on unsupported browsers.
- **Wave 3:** simplified install beyond bunx (single binary / Docker / agent).
- **Wave 4:** hosted bugtoprompt.com — store captured bugs and serve the
  real-time transcription backend multi-tenant; enables prod activation.
- **Deferred SDK cleanup (`req 4`):** removing the front-end raw-key paths
  (`streaming-auth.ts:53-74`, `key-store.ts`, `KeyPrompt` UI,
  `data-assemblyai-key`, `assemblyAiKey` global). They coexist harmlessly when a
  backend is present (backend mint path wins). Safe to defer.

## 7. Risks / verification tasks
1. **Published vs local bugtoprompt (overlay side) parity.** gerarposts uses
   `bugtoprompt@^0.10.0` from npm; the config→createFetchClient→mint→WS path is
   read from local source. Verify the installed `node_modules/bugtoprompt`
   behaves as described. Mitigation: `bun link` the local bugtoprompt during
   dogfood, or publish a patch if the published build diverges.
2. **`bunx` name resolution.** `bunx bugtoprompt-server` resolves a package by
   that name (or a bin of that name). Pin the packaging approach so the command
   works as written.
3. **Broker shipped files.** Ensure `service-security.mjs` and
   `transcript-segments.mjs` are in the package `files` (relative imports must
   resolve from the published bin).
4. **AssemblyAI v3 token shape.** The broker's `handleStreamingToken` already
   maps the v3 token endpoint response — treat it as the source of truth; do not
   re-guess field names.
5. **CORS / origin + scheme.** Broker auto-trusts localhost origins
   (`isOriginAllowed`), so gerarposts dev (any localhost port) is allowed without
   config. Confirm gerarposts dev serves over **http** (not https) so the browser
   may call the `http://localhost:4127` broker without mixed-content blocking; if
   gerarposts dev is https, run the broker over https or proxy it.
6. **Streaming token → WS.** Confirm the minted v3 token drives
   `StreamingTranscriber` to an open AssemblyAI WS end-to-end (the deepest happy
   path); the broker and tapa-rs both already use this mint.

## 8. Testing
- **broker config route:** returns 200 JSON; overlay flips to backend mode.
- **broker streaming-token:** with a valid key, returns `{ token, expiresAt }`;
  upstream error → non-200 JSON (overlay surfaces it).
- **CLI:** `bunx bugtoprompt-server` (and `bun scripts/...`) boots, binds the
  port, refuses to mint without `ASSEMBLYAI_API_KEY`.
- **e2e (local):** broker up + `bun dev` gerarposts, record, assert a non-empty
  transcript renders in the prompt.
