# Console activation (retired)

> ⚠️ **This activation path no longer exists.** The script-tag / DevTools
> console flow documented here previously has been removed from the product.

bugtoprompt is no longer distributed as a copy-paste `<script>` snippet or a
console one-liner. Direct integration (React import, `<script>` tag, or the
bundled `npx` server) is not supported going forward — see the README's
sunset notice for details.

The current product is the **BugToPrompt Chrome extension**:

- **Lite** (free) — the extension paired with a local Rust tray sidecar
  (on-device transcription; issues are filed via the `gh` CLI).
- **Pro** (paid) — the extension talks to the hosted backend at
  [api.bugtoprompt.com](https://api.bugtoprompt.com); captures land in a
  cloud inbox and route onward via connectors (GitHub first).

See the [README](../README.md) for the full sunset notice, the exports this
package still ships (for internal/OSS use as a library), and the extension
model.
