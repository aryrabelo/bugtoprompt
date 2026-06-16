# Console activation

Copy-paste snippets for injecting snap-prompt into any page you can inspect.
No build step, no npm install.

---

## Activate on any page

Injects the standalone script from a CDN (or your own host) and auto-mounts
the widget with `clipboard` and `download` modes:

```js
(()=>{const s=document.createElement('script');s.src='https://YOUR_HOST/snap-prompt.global.js';s.dataset.modes='clipboard,download';document.body.appendChild(s);})()
```

Replace `YOUR_HOST` with wherever you serve `snap-prompt.global.js` (e.g.
`unpkg.com/snap-prompt/dist`).

---

## Production live-transcription unlock

### Option A — raw AssemblyAI key (default, per-developer)

Set `window.__SNAP_PROMPT__` before injecting the script:

```js
window.__SNAP_PROMPT__ = {
  assemblyAiKey: prompt('AssemblyAI key (this tab only)'),
  modes: ['issue', 'clipboard', 'download'],
};
```

Then inject the script (see snippet above, or the `<script>` tag approach).

**Security properties:**
- The key is held only in this tab's JS heap and is never sent to your server.
- It is not in page source, not in network requests to your backend, and not
  persisted anywhere by snap-prompt.
- Each developer supplies their own key through `prompt()` (or hardcodes it in
  their local DevTools snippet — it stays on their machine).
- The v3 streaming **token endpoint is CORS-enabled**, so this mint works
  directly from the browser. If a corporate proxy still blocks it, use
  Option B (pre-minted token) instead.

### Option B — hardened unlock (pre-minted token)

Generate a short-lived token server-side or via the AssemblyAI API, then:

```js
window.__SNAP_PROMPT__ = { streamingToken: '<temp-token>' };
```

Inject the script immediately after. The token is consumed on connection and
expires in at most 10 minutes (or whatever TTL you chose).

This avoids CORS entirely because the browser never calls the AssemblyAI API
directly — you minted the token already.

---

## How the token is resolved

snap-prompt tries each source in order and uses the first one that works:

1. **`streamingToken`** — returned immediately (most reliable; no extra request).
2. **`assemblyAiKey`** (from `window.__SNAP_PROMPT__` **or** the key the overlay
   persisted in `localStorage["snap-prompt:assemblyai-key"]`) — mints a
   short-lived token with `GET https://streaming.assemblyai.com/v3/token?expires_in_seconds=300`
   (`Authorization: <key>`) from the browser. This endpoint is CORS-enabled.
   Falls through on any error.
3. **`client.mintStreamingToken()`** — your backend mints the token
   (the default developer-backend path). Requires a configured `baseUrl`.

If none of the three paths succeeds, the overlay **prompts you for an AssemblyAI
API key** inline (heading "Enable live transcription"). The key you paste is
stored in `localStorage` and applied to the live session immediately (the mic is
already recording, so transcription attaches mid-capture). Batch-fallback
transcription on stop only runs when a backend `transcribeBatch` is configured.

The live socket always selects **Universal-3 Pro** (`speech_model=u3-rt-pro`).

---

## Pre-provision the key on the `<script>` tag

The standalone build reads `data-assemblyai-key` and stores it client-side
before mounting, so a page can enable live transcription with no console step:

```html
<script src="https://YOUR_HOST/snap-prompt.global.js" data-assemblyai-key="YOUR_KEY"></script>
```

---

## CORS note

When using `assemblyAiKey`, the browser calls
`https://streaming.assemblyai.com/v3/token` directly. That endpoint is
CORS-enabled for browser token generation, so it works from `localhost` and
production origins alike. If a network policy still blocks it, pre-mint a token
(Option B) and paste it as `streamingToken`.
