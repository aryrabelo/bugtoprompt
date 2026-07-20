# Chrome Web Store listing copy

Source of truth for the BugToPrompt listing on the Chrome Web Store
Developer Dashboard. Paste the relevant field into the corresponding
dashboard input — do not upload this file itself.

## Extension name

```
BugToPrompt
```

## Summary (single sentence, ≤132 characters incl. spaces)

```
Capture a bug as a click timeline + voice narration + screenshots, rendered as an AI-ready prompt or GitHub issue.
```

_(114 characters)_

## Category

Developer Tools

## Language

English (en)

## Detailed description

```
Capture a bug, get a prompt your AI agent can fix.

BugToPrompt turns a confusing local-dev bug into a complete, AI-ready
report in one recording — no more re-explaining what you clicked, or
manually stitching screenshots into a GitHub issue by hand.

HOW IT WORKS

1. Open your app on localhost and click the BugToPrompt toolbar icon
   (or press Cmd/Ctrl+Shift+Y).
2. Hit Start capture and walk through the bug like you're narrating it
   to a coworker.
3. BugToPrompt records:
   - A numbered click timeline (a marker on every click; a screenshot too
     when screen capture is enabled and permission is granted)
   - Live voice narration, transcribed as you talk
   - A click-centered screenshot (or a downscaled full frame) plus
     interactive element metadata — role, name, selector, position — at
     each step
4. Stop capture. BugToPrompt renders everything into a single,
   structured prompt — paste it straight into Claude, Cursor, or Codex,
   or file it as a GitHub issue with one click.

WHY IT'S DIFFERENT

- Built for local dev. Activates automatically only on http://localhost
  and 127.0.0.1 — capturing on any other site requires you to first
  grant it access to that specific origin ("Enable on this site").
- No copy-pasting screenshots into a doc, no rewriting your verbal
  explanation into a bug report — the transcript and timeline are
  captured directly out of your own words.
- Two ways to run it:
    - Lite (free) — pairs with a local Rust tray sidecar; transcription
      happens on-device, issues are filed via your own gh CLI.
    - Pro (paid) — talks to the hosted BugToPrompt backend; captures
      land in a cloud inbox and route onward through connectors
      (GitHub first, more coming).

PRIVACY

BugToPrompt activates automatically only on localhost/127.0.0.1 pages;
capturing on any other site requires you to first grant it access to
that origin. Screen and audio capture require your explicit browser
permission grant every time. See the privacy policy at
https://bugtoprompt.com/privacy for full details on what is collected
and where it is sent (Lite: stays on-device, except voice transcription
falls back to AssemblyAI's cloud API when the local parakeet-mlx engine
is unavailable and an AssemblyAI key is configured; Pro: sent to your
account on api.bugtoprompt.com).

OPEN SOURCE

The capture engine and prompt renderer are MIT-licensed and open source:
https://github.com/aryrabelo/bugtoprompt
```

> **Blocking before submission:** `https://bugtoprompt.com/privacy`
> returns 404 as of this writing — the page does not exist yet. It must
> be published before the detailed description above can be pasted
> as-is into the dashboard. See `CHECKLIST.md` § Privacy.

## Screenshot captions (Chrome Web Store screenshot slots)

1. **screenshot-1-popup-1280x800.png** — "Start a capture from any
   localhost tab — see sidecar status and target repo at a glance."
2. **screenshot-2-capture-1280x800.png** — "Every click gets a numbered
   marker and a screenshot, while your narration streams live."
3. **screenshot-3-issue-1280x800.png** — "Stop capture and get a
   structured, AI-ready prompt — file it as a GitHub issue in one click."

## Promotional tile captions

- **small-tile-440x280.png** — icon + wordmark + one-line tagline, used
  in search results and category listings.
- **large-promo-920x680.png** — icon + wordmark + tagline + feature
  pills, used on the extension's detail page hero and in featured
  placements.
