# BugToPrompt Wave 1 — Local Self-Hosted Broker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make BugToPrompt voice transcription work end-to-end in the `gerarposts` app, backed by the existing standalone broker run via `bunx bugtoprompt-server` — no backend changes to gerarposts.

**Architecture:** The bugtoprompt overlay already ships the full client→backend path; it only activates when `GET /bugtoprompt/config` returns 200. The repo already contains a complete, dependency-free broker (`scripts/github-issue-service.mjs`) that serves that route plus `POST /streaming-token` (mints a 300s AssemblyAI token so the raw key never reaches the browser). Phase A points gerarposts at the broker for immediate value; Phase B packages the broker as the publishable `bugtoprompt-server` for `bunx`.

**Tech Stack:** Node `node:` builtins (broker), Bun 1.3.14 (runtime/CLI), Vite + TanStack Start (gerarposts overlay host), AssemblyAI v3 streaming, npm (publish).

**Cross-repo:** edits land in two repos — `~/Sites/bugtoprompt` (broker/package) and `~/Sites/gerarposts` (host config + docs). Each task states which.

**Prerequisite:** an AssemblyAI API key. Export it where the broker runs:
`export ASSEMBLYAI_API_KEY=<your-key>` (never commit it; the broker reads `process.env.ASSEMBLYAI_API_KEY` at `scripts/github-issue-service.mjs:445`).

---

## Phase A — Transcription works in gerarposts (value first)

### Task 1: Smoke-test the broker locally

**Files:** none modified (uses `~/Sites/bugtoprompt/scripts/github-issue-service.mjs`).

- [ ] **Step 1: Start the broker with Bun**

Run (shell A):
```bash
cd ~/Sites/bugtoprompt
ASSEMBLYAI_API_KEY=$ASSEMBLYAI_API_KEY bun scripts/github-issue-service.mjs
```
Expected: a line like `bugtoprompt issue service on http://localhost:4127 (issue mode disabled)` and the process stays bound to `127.0.0.1:4127`.

- [ ] **Step 2: Verify the config gate returns 200**

Run (shell B):
```bash
curl -s -i http://localhost:4127/bugtoprompt/config | head -1
curl -s http://localhost:4127/bugtoprompt/config
```
Expected: `HTTP/1.1 200 OK` and a JSON body containing `"projectId"` (e.g. `{"modes":["clipboard","download"],"projectId":"bugtoprompt"}`). This 200 is the gate that flips the overlay to the backend client (`src/overlay/BugToPrompt.tsx:191-203`).

- [ ] **Step 3: Verify the streaming-token mint**

Run (shell B):
```bash
curl -s -XPOST http://localhost:4127/streaming-token \
  -H 'Content-Type: application/json' -d '{}'
```
Expected: `{"token":"<string>","expiresAt":<number>}` (HTTP 200).
- `501 {"error":"ASSEMBLYAI_API_KEY not configured"}` → the key was not exported in shell A.
- `502 AssemblyAI token mint failed: <status>` → the key is invalid or AssemblyAI is unreachable. Fix the key before continuing.

- [ ] **Step 4: No commit**

Verification only — no files changed.

---

### Task 2: Point gerarposts at the broker

**Files:**
- Create: `~/Sites/gerarposts/apps/web/.env.local`

- [ ] **Step 1: Create the local env file**

Create `~/Sites/gerarposts/apps/web/.env.local` with exactly:
```
VITE_BUGTOPROMPT_BASE_URL=http://localhost:4127
```
This is read by the mount at `apps/web/src/components/bugtoprompt-mount.tsx:23` (`import.meta.env.VITE_BUGTOPROMPT_BASE_URL`) and passed to `<BugToPrompt baseUrl=… />`. The overlay then calls `${base}/bugtoprompt/config` and `${base}/streaming-token`.

- [ ] **Step 2: Confirm no code change is needed**

Run:
```bash
grep -n 'VITE_BUGTOPROMPT_BASE_URL' ~/Sites/gerarposts/apps/web/src/components/bugtoprompt-mount.tsx
```
Expected: line 23 already reads the var. No edit required.

- [ ] **Step 3: No commit**

`.env.local` is local dev config (gitignored). It is documented for others in Task 6 (README + `.env.example`). Do not commit a key or a localhost URL.

---

### Task 3: End-to-end dogfood + resolve overlay parity

**Files:** none (runtime verification); conditional `bun link` if the published overlay diverges.

- [ ] **Step 1: Ensure the broker is running**

Shell A from Task 1 still up (`http://localhost:4127`).

- [ ] **Step 2: Start gerarposts (http dev)**

Run (shell C):
```bash
cd ~/Sites/gerarposts
bun dev
```
Expected: a dev URL is printed (e.g. `http://localhost:3000`). Note the scheme is **http** — required so the page may call the `http://localhost:4127` broker without mixed-content blocking (spec risk #5). If the dev server is https, run the broker behind https or a proxy.

- [ ] **Step 3: Record a bug with voice**

In the browser at the dev URL: click the BugToPrompt overlay button → start recording → speak ~5 seconds → stop.
Expected: live captions appear while recording; the review screen shows a **non-empty transcript**; "No transcript yet." does **not** appear.

- [ ] **Step 4: If the transcript is empty, resolve parity**

gerarposts uses `bugtoprompt@^0.10.0` from npm. If the overlay never flipped to backend mode (no network call to `/bugtoprompt/config` in devtools) or transcription stayed empty while Task 1 mint worked, link the local build:
```bash
cd ~/Sites/bugtoprompt && npm run build && bun link
cd ~/Sites/gerarposts/apps/web && bun link bugtoprompt
cd ~/Sites/gerarposts && bun dev   # restart
```
Re-run Step 3. Expected: non-empty transcript. (Confirms whether a published-vs-local divergence exists; if linking fixes it, a patch release of `bugtoprompt` is needed — track separately, out of Wave 1 scope.)

- [ ] **Step 5: Record the outcome**

Note in the PR/commit description whether dogfood passed with the published overlay or required `bun link`. No code commit in this task.

---

## Phase B — Package the broker as `bugtoprompt-server` (for `bunx`)

### Task 4: Create the `bugtoprompt-server` package (re-home the broker)

The broker files are not imported by `src/` (verified), so they move cleanly into a dedicated, self-contained package whose name matches the `bunx` command.

**Files (in `~/Sites/bugtoprompt`):**
- Move: `scripts/github-issue-service.mjs` → `server/github-issue-service.mjs`
- Move: `scripts/service-security.mjs` → `server/service-security.mjs`
- Move: `scripts/service-security.test.mjs` → `server/service-security.test.mjs`
- Move: `scripts/transcript-segments.mjs` → `server/transcript-segments.mjs`
- Move: `scripts/transcript-segments.test.mjs` → `server/transcript-segments.test.mjs`
- Create: `server/package.json`
- Modify: `package.json:61` (`service:github` script path)
- Modify: `SECURITY.md:58` (file path reference)

- [ ] **Step 1: Move the five broker files with git**

```bash
cd ~/Sites/bugtoprompt
mkdir -p server
git mv scripts/github-issue-service.mjs server/github-issue-service.mjs
git mv scripts/service-security.mjs server/service-security.mjs
git mv scripts/service-security.test.mjs server/service-security.test.mjs
git mv scripts/transcript-segments.mjs server/transcript-segments.mjs
git mv scripts/transcript-segments.test.mjs server/transcript-segments.test.mjs
```
The relative imports between these files (e.g. `./service-security.mjs`, `./transcript-segments.mjs`) and the shebang `#!/usr/bin/env node` at the top of `github-issue-service.mjs` are unchanged — they move together, so nothing inside the files needs editing.

- [ ] **Step 2: Create `server/package.json`**

Create `~/Sites/bugtoprompt/server/package.json`:
```json
{
	"name": "bugtoprompt-server",
	"version": "0.1.0",
	"description": "Local self-hosted broker for the BugToPrompt overlay — mints AssemblyAI streaming tokens so the API key never reaches the browser.",
	"type": "module",
	"license": "MIT",
	"repository": {
		"type": "git",
		"url": "git+https://github.com/aryrabelo/bugtoprompt.git",
		"directory": "server"
	},
	"engines": {
		"node": ">=18"
	},
	"bin": {
		"bugtoprompt-server": "./github-issue-service.mjs"
	},
	"files": [
		"github-issue-service.mjs",
		"service-security.mjs",
		"transcript-segments.mjs"
	]
}
```
`files` ships only the three runtime modules (tests excluded). `bin` maps the `bunx bugtoprompt-server` command to the shebang'd entry.

- [ ] **Step 3: Update the root `service:github` script**

In `~/Sites/bugtoprompt/package.json`, change line 61 from:
```json
		"service:github": "node scripts/github-issue-service.mjs"
```
to:
```json
		"service:github": "node server/github-issue-service.mjs"
```

- [ ] **Step 4: Update the path reference in `SECURITY.md`**

In `~/Sites/bugtoprompt/SECURITY.md`, change the `scripts/github-issue-service.mjs` reference (line ~58) to `server/github-issue-service.mjs`.
Verify no stale refs remain:
```bash
grep -rn 'scripts/github-issue-service\|scripts/service-security\|scripts/transcript-segments' . \
  --include='*.md' --include='*.json' | grep -v node_modules
```
Expected: no matches (the `docs/superpowers/specs/*.md` historical mentions are fine to leave; if the lint is strict, leave the spec as-is — it is a dated artifact).

- [ ] **Step 5: Run the test suite**

```bash
cd ~/Sites/bugtoprompt && npm test
```
Expected: PASS, including `server/service-security.test.mjs` and `server/transcript-segments.test.mjs` (vitest's default glob picks up `server/**/*.test.mjs`; no config change needed since `vitest.config.ts` sets no custom `include`).

- [ ] **Step 6: Smoke-test the moved broker**

```bash
ASSEMBLYAI_API_KEY=$ASSEMBLYAI_API_KEY bun server/github-issue-service.mjs
```
Expected: same startup line as Task 1, bound to `127.0.0.1:4127`. Stop it after confirming.

- [ ] **Step 7: Commit**

```bash
cd ~/Sites/bugtoprompt
git add server package.json SECURITY.md
git commit -m "refactor: extract broker into publishable bugtoprompt-server package"
```

---

### Task 5: Verify the package contents and the no-key guard

**Files:** none (verification).

- [ ] **Step 1: Confirm the publish manifest**

```bash
cd ~/Sites/bugtoprompt/server && npm pack --dry-run
```
Expected: the listed files are exactly `package.json`, `github-issue-service.mjs`, `service-security.mjs`, `transcript-segments.mjs` (no test files, no extras).

- [ ] **Step 2: Confirm the bin boots and refuses to mint without a key**

```bash
cd ~/Sites/bugtoprompt
( unset ASSEMBLYAI_API_KEY; node server/github-issue-service.mjs & sleep 1; \
  curl -s -XPOST http://localhost:4127/streaming-token -d '{}'; kill %1 )
```
Expected: the server boots, and the mint returns `501 {"error":"ASSEMBLYAI_API_KEY not configured"}` — the key guard at `server/github-issue-service.mjs:446-448` holds.

- [ ] **Step 3: No commit**

Verification only.

---

### Task 6: Publish and document `bunx bugtoprompt-server`

**Files (in `~/Sites/bugtoprompt`):**
- Modify: `README.md` (add a "Local transcription broker" quickstart)

**Files (in `~/Sites/gerarposts`):**
- Modify or create: `apps/web/.env.example` (document `VITE_BUGTOPROMPT_BASE_URL`)

- [ ] **Step 1: Publish the package**

```bash
cd ~/Sites/bugtoprompt/server
npm publish --access public
```
Expected: `+ bugtoprompt-server@0.1.0`. (Requires `npm login` first.)

- [ ] **Step 2: Verify `bunx` resolves the published name**

In a fresh shell (no local link):
```bash
ASSEMBLYAI_API_KEY=$ASSEMBLYAI_API_KEY bunx bugtoprompt-server
```
Expected: downloads and boots, printing the startup line on `127.0.0.1:4127`. Stop after confirming.

- [ ] **Step 3: Document the broker in `README.md`**

Add a section to `~/Sites/bugtoprompt/README.md`:
```markdown
## Local transcription broker (self-hosted)

Voice transcription needs a backend to mint short-lived AssemblyAI tokens
(the API key never reaches the browser). Run the broker locally:

    ASSEMBLYAI_API_KEY=<your-key> bunx bugtoprompt-server   # http://localhost:4127

Then point the overlay at it. In a Vite app, set:

    VITE_BUGTOPROMPT_BASE_URL=http://localhost:4127

The overlay calls `GET /bugtoprompt/config` (activates backend mode) and
`POST /streaming-token` (mints the token); the browser opens AssemblyAI's
WebSocket directly. Serve your app over **http** in dev so it can reach the
http broker without mixed-content blocking.
```

- [ ] **Step 4: Document the env var in gerarposts**

In `~/Sites/gerarposts/apps/web/.env.example` add (create the file if absent):
```
# Point the BugToPrompt overlay at a local broker (bunx bugtoprompt-server).
VITE_BUGTOPROMPT_BASE_URL=http://localhost:4127
```

- [ ] **Step 5: Commit (both repos)**

```bash
cd ~/Sites/bugtoprompt && git add README.md && \
  git commit -m "docs: document bugtoprompt-server broker + overlay base URL"
cd ~/Sites/gerarposts && git add apps/web/.env.example && \
  git commit -m "docs: document VITE_BUGTOPROMPT_BASE_URL for local broker"
```

---

## Self-Review

**Spec coverage:**
- Spec §2 (standalone broker, already exists) → Tasks 1, 4.
- Spec §3 (architecture: config gate + mint, key server-side) → Tasks 1–3.
- Spec §4.1 packaging as `bugtoprompt-server` bin → Task 4; `bunx` form → Task 6.
- Spec §4.2 immediate dogfood via `bun scripts/...` → Task 1 (and Task 4 Step 6 after move).
- Spec §4.3 point gerarposts via `VITE_BUGTOPROMPT_BASE_URL` → Task 2.
- Spec §4.4 acceptance (non-empty transcript) → Task 3.
- Spec §5 (prod konami/6-digit) → explicitly out of scope; no task. ✔
- Spec §7 risks: #1 parity → Task 3 Step 4; #2 bunx name → Task 6 Step 2; #3 shipped files → Task 5 Step 1; #4 token shape → reuses existing `handleStreamingToken`; #5 origin/scheme → Task 3 Step 2; #6 token→WS → Task 3 Step 3.
- Spec §8 testing → Task 1 (config/mint), Task 5 (CLI/no-key), Task 3 (e2e).

**Placeholder scan:** no TBD/TODO; every code/command step shows real content. ✔

**Type/name consistency:** package name `bugtoprompt-server`, bin `bugtoprompt-server`, entry `github-issue-service.mjs`, env var `ASSEMBLYAI_API_KEY`, base URL var `VITE_BUGTOPROMPT_BASE_URL`, port `4127` — used consistently across tasks. ✔
