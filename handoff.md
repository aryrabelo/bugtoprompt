# Handoff — issue #57 (macOS menu-bar tray shell)

## Summary

New `sidecar-tray/` crate: a macOS menu-bar app (`tray-icon` crate, PRD §11)
that embeds the axum sidecar server (`sidecar_rust::serve`, #54) as a
supervised background task in the same process. `sidecar-rust` gained a
minimal `lib.rs` (flagged edit, see below) so the server is embeddable
instead of only runnable as a standalone binary.

## Visual

The tray shows a menu-bar icon (16×16 generated glyph, template-rendered so
it adapts to light/dark menu bars — real app icon is #59's job) with:

```
🐛 BugToPrompt ● Running (port 4127)   ← disabled status line
───────────────────────────────────
Settings                              ← no-op placeholder (#58 owns the window)
Open logs                             ← opens ~/Library/Logs/BugToPrompt in Finder
───────────────────────────────────
Quit                                  ← graceful shutdown, then exits
```

`ActivationPolicy::Accessory` is set so the app has no Dock icon and doesn't
appear in the app switcher — pure menu-bar presence, matching the PRD
mockup (§4).

## Sidecar-rust edit (flagged, per assignment instructions)

Added `sidecar-rust/src/lib.rs` and slimmed `src/main.rs` to a thin wrapper.
**No route, handler, or behavioral change** — `handlers.rs`/`app.rs` are
untouched. This was "strictly needed": the issue requires the server to run
"as an embedded async task on the same process, not a separate subprocess",
which is impossible without a library target to depend on. Full diff
detail in RUN-LOG.md.

## Gates (all commands + output in RUN-LOG.md)

- `sidecar-rust`: `cargo fmt --check` / `cargo clippy --all-targets -- -D
  warnings` / `cargo build` / `cargo test` — all green (17 lib+bin tests +
  10 integration tests).
- `sidecar-tray`: `cargo fmt --check` / `cargo clippy --all-targets -- -D
  warnings` / `cargo build` / `cargo test` — all green (2 supervisor tests).

## Smoke

1. Automated: `sidecar-tray`'s `cargo test` spawns the real
   `Supervisor`/`sidecar_rust::serve` path, does a raw HTTP GET to
   `/health`, asserts `200`, then asserts the port is free immediately
   after `shutdown()`.
2. Manual: built a throwaway example running just the supervisor path
   (no GUI loop) and hit it with real `curl` — `200` while running,
   connection refused after the process is killed. Full transcript in
   RUN-LOG.md. Example file was deleted before commit, not part of the
   diff.

## Deferred

- **Interactive GUI verification (macOS only).** I have no way to drive a
  real NSStatusItem/menu click cycle from this sandbox. Someone with a
  macOS desktop session should run `cargo run` in `sidecar-tray/` and
  confirm: (a) the icon appears in the menu bar with the three items and
  the status line, (b) clicking Settings logs the placeholder message and
  does nothing else, (c) clicking Open logs opens Finder at
  `~/Library/Logs/BugToPrompt`, (d) clicking Quit removes the icon and
  `curl http://127.0.0.1:4127/health` starts failing.
- **Windows tray (#59's successor issue, v2).** Explicitly out of scope
  here per the issue and PRD §12; no Windows-specific code was added.
  `tray-icon`/`tao` were chosen because they're the PRD-mandated
  cross-platform pair, so the same crate carries over — but no
  `#[cfg(windows)]` paths exist yet.
- **Real log file.** "Open logs" opens a directory, but nothing writes a
  log *file* into it yet — `tracing_subscriber::fmt()` still only writes to
  stdout (same as the standalone `sidecar-rust` binary). Wiring a rolling
  file appender wasn't asked for here and would be better scoped with
  Settings (#58) or packaging (#59), whichever ends up owning where logs
  should live for a bundled `.app`.
- **`sidecar-rust` integration test flakiness under parallel `cargo test`.**
  Pre-existing race in `tests/integration.rs`'s ephemeral-port selection
  helper (documented in RUN-LOG.md), unrelated to and untouched by this
  issue. Not fixed here — out of my file-ownership scope
  (`tests/integration.rs` wasn't mine to edit).
- **CI for `sidecar-tray`.** No workflow file added — the existing
  `sidecar-rust.yml` is `ubuntu-latest` and path-scoped to `sidecar-rust/**`
  only, and `sidecar-tray` needs a macOS runner (uses `tao`/`tray-icon`
  macOS APIs that won't cross-compile). Left to whoever wires up
  packaging/CI for the new crate (#59 territory) rather than guessing at a
  workflow shape now.

## Not touched

`sidecar-rust/src/handlers.rs`, `sidecar-rust/src/app.rs` (route table),
and all files outside `sidecar-rust/` + `sidecar-tray/`.
