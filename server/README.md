# bugtoprompt-server

Local self-hosted broker for the [BugToPrompt](https://github.com/aryrabelo/bugtoprompt)
bug-capture overlay. It mints short-lived AssemblyAI streaming tokens so the
overlay can do live voice transcription **without the API key ever reaching the
browser** — the key stays in this process.

## Run (no install)

```bash
ASSEMBLYAI_API_KEY=<your-key> bunx bugtoprompt-server   # http://localhost:4127
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
| `BUGTOPROMPT_PORT` | `4127` | listen port |
| `BUGTOPROMPT_ALLOWED_ORIGINS` | — | comma-separated extra origins; localhost is auto-trusted |
| `BUGTOPROMPT_TOKEN` | — | optional shared secret required on every non-OPTIONS request |
| `BUGTOPROMPT_ENABLE_ISSUES` | `0` | set `1` to enable `/issue` (needs the `gh` CLI authenticated) |
| `BUGTOPROMPT_REPOS` | — | comma-separated repos exposed as targets |
| `BUGTOPROMPT_PROJECT_ID` | `bugtoprompt` | advertised projectId |

The broker binds `127.0.0.1`, applies an origin allowlist, and validates
sessionIds against path traversal. It is a developer tool — front it with TLS and
auth before exposing it beyond localhost.

## License

MIT
