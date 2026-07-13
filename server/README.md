# bugtoprompt sidecar

Local self-hosted broker for the [BugToPrompt](https://github.com/aryrabelo/bugtoprompt)
bug-capture overlay, shipped inside the `bugtoprompt` package (formerly the
standalone `bugtoprompt-server` npm package; the hosted role moved to
[bugtoprompt.com](https://bugtoprompt.com)). It mints short-lived AssemblyAI
streaming tokens so the overlay can do live voice transcription **without the
API key ever reaching the browser** — the key stays in this process.

## Run (no install)

```bash
ASSEMBLYAI_API_KEY=<your-key> npx bugtoprompt   # http://localhost:4127
```

Then point the overlay at it. In a Vite app:

```
VITE_BUGTOPROMPT_BASE_URL=http://localhost:4127
```

Serve your app over **http** in dev so the page can reach the http broker without
mixed-content blocking.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/bugtoprompt/config` | advertised modes / projectId — its `200` activates the overlay's backend mode |
| `POST` | `/streaming-token` | mint a 300s AssemblyAI streaming token (`{ token, expiresAt }`) |
| `POST` | `/transcribe` | AssemblyAI batch transcript of a saved capture |
| `POST` | `/artifact` | persist `artifact.json` + audio + screenshots |
| `GET`  | `/targets` | configured repos as targets |
| `POST` | `/issue` | `gh issue create` against the chosen repo (issue mode) |

## Configuration (env)

| Variable | Default | Notes |
|---|---|---|
| `ASSEMBLYAI_API_KEY` | — | required for transcription; without it `/streaming-token` and `/transcribe` return `501` |
| `BUGTOPROMPT_HOST` | `127.0.0.1` | bind address; set to `0.0.0.0` to expose beyond localhost (add auth + TLS) |
| `BUGTOPROMPT_PORT` | `4127` | listen port |
| `BUGTOPROMPT_REPOS` | — | comma-separated repos as targets: `owner/repo[#branch]` |
| `BUGTOPROMPT_PROJECT_ID` | `bugtoprompt` | advertised projectId |
| `BUGTOPROMPT_ENABLE_ISSUES` | `0` | set `1` to enable `/issue` (needs the `gh` CLI authenticated) |
| `BUGTOPROMPT_ALLOWED_ORIGINS` | — | comma-separated extra origins; localhost & Tauri are auto-trusted |
| `BUGTOPROMPT_TOKEN` | — | optional shared secret (`Authorization: Bearer <token>`) required on every non-OPTIONS request |
| `BUGTOPROMPT_SCREENSHOT_MODE` | — | passed through to the client via `/bugtoprompt/config` |
| `BUGTOPROMPT_ENV` | — | environment label (e.g. `staging`) passed through via `/bugtoprompt/config` |
| `BUGTOPROMPT_CONFIG` | — | inline JSON or path to a JSON config file; merged before env overrides |

Full descriptions and defaults live in the JSDoc at the top of `github-issue-service.mjs`.

The server applies an origin allowlist and validates session IDs against path traversal.
It is a developer tool — front it with TLS and auth before exposing it beyond localhost.

## License

MIT
