# Security Policy

## Reporting a vulnerability

Please report security issues **privately**. Use GitHub's "Report a
vulnerability" flow (the repository's **Security > Advisories** tab) on
[github.com/aryrabelo/bugtoprompt](https://github.com/aryrabelo/bugtoprompt) —
do **not** open a public issue for a security report.

We aim to acknowledge a report within **7 days** (best effort) and will keep
you updated as we investigate and ship a fix.

## Supported versions

This is a `0.x` package; only the latest minor receives fixes.

| Version       | Supported          |
| ------------- | ------------------ |
| latest `0.x`  | :white_check_mark: |
| older `0.x`   | :x:                |

## Security & privacy notes for users

bugtoprompt captures rich bug context. Understand what it collects before
deploying it, and review captures before sharing them.

### What gets captured

The overlay can capture potentially sensitive data:

- **Microphone audio** (live voice transcription).
- **Interactive DOM snapshots**, which may include input values and any
  on-screen text.
- **Screenshots** — full screen-share pixels via `getDisplayMedia`.
- **Page URLs** and **click coordinates**.

In `clipboard` and `download` mode, **nothing leaves the browser**. In `issue`
mode, the assembled artifact is sent to the configured backend.

### Redaction is partial

The renderer redacts credential-**shaped** strings — tokens, `KEY=value`,
`Bearer`, JWTs, and provider personal access tokens — before the prompt leaves
the tab. It does **not** redact arbitrary PII, and it does **not** redact
pixels inside screenshots. Review every capture before sharing it.

### The AssemblyAI streaming token

Live transcription authenticates via a short-lived (**≤600s**) streaming
token minted server-side by our backend (`mintStreamingToken`) — the
customer never stores or holds a raw AssemblyAI key. Treat a host-injected
`window.__BUGTOPROMPT__.streamingToken` as a tab-scoped secret readable by
any same-origin script.

### The reference backend

`server/github-issue-service.mjs` is a **local dev tool**, not a hardened
service. Run it only on a trusted machine, bound to `127.0.0.1`, and set
`BUGTOPROMPT_ALLOWED_ORIGINS` and `BUGTOPROMPT_TOKEN` as documented.
