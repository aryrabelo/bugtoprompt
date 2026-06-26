# bugtoprompt – example

This directory contains a plain-HTML demo with no build step required.
Open `index.html` in a browser (or serve it with any static server).

---

## Script-tag (any site, no framework)

```html
<script
  src="https://unpkg.com/bugtoprompt/dist/bugtoprompt.global.js"
  defer
  data-modes="clipboard,download"
></script>
```

The overlay self-mounts in the bottom-right corner. No React, no bundler.

**Local build** — if you want to test against your local checkout, run
`pnpm build` first, then change `src` to `../dist/bugtoprompt.global.js`.

### `data-*` attributes

| Attribute | Values | Description |
|---|---|---|
| `data-modes` | `clipboard,download,issue` | Which export actions to show |
| `data-base` | URL | Backend base URL (e.g. `http://localhost:3000`) |
| `data-project-id` | string | Project to file issues against |
| `data-screenshot-mode` | `onMark` \| `perPage` \| `off` | When to capture screenshots |
| `data-default-mode` | string | Primary action button |

---

## React (with bundler)

Install:

```bash
npm i bugtoprompt
# peer deps if not already present:
npm i react react-dom
```

Drop into your root component:

```tsx
import { BugToPrompt } from 'bugtoprompt';

export default function App() {
  return (
    <>
      {/* ...your app... */}
      <BugToPrompt />
    </>
  );
}
```

Zero required props. The component degrades to clipboard/download with no
backend configured. To wire a backend, pass `config`:

```tsx
<BugToPrompt
  config={{ base: 'https://your-api.example.com', modes: ['issue'] }}
/>
```

Or let the overlay auto-discover a backend via `window.__BUGTOPROMPT__`,
a `<meta name="bugtoprompt-config">` tag, or a same-origin
`GET /bugtoprompt/config` endpoint.

---

## Reference backend (optional)

`server/github-issue-service.mjs` in the repo root is a ready-to-run
Node.js server that files GitHub issues. Run it with:

```bash
GITHUB_TOKEN=ghp_... GITHUB_OWNER=your-org GITHUB_REPO=your-repo \
  node server/github-issue-service.mjs
```

Then point the overlay at it via `data-base` or `config.base`.
