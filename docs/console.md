# Console activation

Copy-paste snippets for injecting bugtoprompt into any page you can inspect.
No build step, no npm install.

---

## Activate on any page

Injects the standalone script from a CDN (or your own host) and auto-mounts
the widget with `clipboard` and `download` modes:

```js
(()=>{const s=document.createElement('script');s.src='https://YOUR_HOST/bugtoprompt.global.js';s.dataset.modes='clipboard,download';document.body.appendChild(s);})()
```

Replace `YOUR_HOST` with wherever you serve `bugtoprompt.global.js` (e.g.
`unpkg.com/bugtoprompt/dist`).

---

## Production live-transcription unlock

### Option A — raw AssemblyAI key (proxy-only; last resort)

Set `window.__BUGTOPROMPT__` before injecting the script:

```js
window.__BUGTOPROMPT__ = {
  assemblyAiKey: prompt('AssemblyAI key (this tab only)'),
  modes: ['issue', 'clipboard', 'download'],
};
```

Then inject the script (see snippet above, or the `<script>` tag approach).

**Security properties:**
- The key is held only in this tab's JS heap and is never sent to your server.
- It is not in page source, not in network requests to your backend, and not
  persisted anywhere by bugtoprompt.
- Each developer supplies their own key through `prompt()` (or hardcodes it in
  their local DevTools snippet — it stays on their machine).
- AssemblyAI's v3 **token endpoint does NOT allow browser CORS** (preflight
  returns 405). A raw in-browser `assemblyAiKey` mint therefore only succeeds
  behind a CORS-permitting proxy; otherwise it fails and the resolver falls
  through. For a reliable client-side unlock prefer Option B (pre-minted token)
  or a host-provided `mintStreamingToken` (e.g. an extension or desktop worker).

### Option B — hardened unlock (pre-minted token)

Generate a short-lived token server-side or via the AssemblyAI API, then:

```js
window.__BUGTOPROMPT__ = { streamingToken: '<temp-token>' };
```

Inject the script immediately after. The token is consumed on connection and
expires in at most 10 minutes (or whatever TTL you chose).

This avoids CORS entirely because the browser never calls the AssemblyAI API
directly — you minted the token already.

---

## How the token is resolved

bugtoprompt tries each source in order and uses the first one that works:

1. **`streamingToken`** — returned immediately (most reliable; no extra request).
2. **`mintStreamingToken`** (from `window.__BUGTOPROMPT__` or your `client`) — a
   host-provided async minter (extension/desktop worker, or a native Tauri
   command) that mints the token where browser CORS does not apply. Preferred
   for a live client-side unlock.
3. **`assemblyAiKey`** (from `window.__BUGTOPROMPT__` **or** the key the overlay
   persisted in `localStorage["bugtoprompt:assemblyai-key"]`) — attempts a direct
   `GET https://streaming.assemblyai.com/v3/token?expires_in_seconds=300`
   (`Authorization: <key>`) from the browser. AssemblyAI's endpoint does **not**
   permit browser CORS (405 preflight), so this only works behind a proxy and
   falls through on any error.
4. **`client.mintStreamingToken()`** — your backend mints the token
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
<script src="https://YOUR_HOST/bugtoprompt.global.js" data-assemblyai-key="YOUR_KEY"></script>
```

---

## CORS note

AssemblyAI's v3 token endpoint (`https://streaming.assemblyai.com/v3/token`)
does **not** permit browser CORS — a direct `fetch` from a page triggers a
preflight that returns 405. So the raw-`assemblyAiKey` mint only works behind a
CORS-permitting proxy. To unlock live transcription reliably, mint the token
out-of-band and hand it back: pass a pre-minted `streamingToken` (Option B), or
provide `window.__BUGTOPROMPT__.mintStreamingToken` (an extension/desktop worker,
or a Tauri command that mints in native code where CORS does not apply). The
streaming **WebSocket** itself is not subject to CORS, so once you have a token
the live session connects normally.
