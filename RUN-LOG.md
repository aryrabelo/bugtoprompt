# RUN-LOG — issue #57 (macOS menu-bar tray shell)

Append-only. Worktree `issue-57`, branch `issue-57`, base `main@01bea51`.

## Ground

- `gh issue view 57 --comments` / `gh issue view 53`: v1 macOS-only tray,
  `tray-icon` crate (PRD §11), embed the axum server as an async task in the
  same process (not a subprocess), menu items: status line, Settings
  (no-op/placeholder until #58), Open logs, Quit (graceful shutdown, port
  released).
- `docs/PRD-SIDECAR-RUST-APP.md` §4 (Architecture) and §11 (Tech Stack):
  `tray-icon` crate chosen (cross-platform, carries to a future Windows
  issue); Settings is a Tauri webview owned by #58, not this issue.
- `sidecar-rust/src/main.rs` (pre-#57): binary boots by loading `Config`,
  spawning `gh`/transcription background probes, binding
  `TcpListener`, and calling `axum::serve(...).with_graceful_shutdown(...)`.
  No library target existed — the tray needs one to embed the server as
  described above.

## Implementation

- **`sidecar-rust` (flagged edit, kept minimal per assignment):** added
  `sidecar-rust/src/lib.rs` exposing the existing modules
  (`app`/`config`/`handlers`/`mw`/`preflight`/`security`/`state`) plus a new
  `pub async fn serve(config, shutdown) -> io::Result<()>` that does exactly
  what `main()` used to do inline (spawn the two background preflight
  probes, bind, `axum::serve(...).with_graceful_shutdown(shutdown)`), except
  the shutdown future is now a caller-supplied parameter instead of the
  hardcoded Ctrl+C/SIGTERM signal. `src/main.rs` shrank to a thin wrapper:
  loads `Config`, validates issue-mode/targets, calls
  `sidecar_rust::serve(config, shutdown_signal())`. `shutdown_signal()`
  (Ctrl+C/SIGTERM) and the `#[cfg(test)] mod tests` block are unchanged.
  No route/handler/behavior changes — did not touch `handlers.rs` or
  `app.rs`'s route table.
- **`sidecar-tray/` (new crate):**
  - `Cargo.toml`: `tray-icon = "0.24"` (menu bar icon + `muda` menus,
    PRD-mandated), `tao = "0.35"` (`no-default-features`, tray-icon's
    companion event-loop crate — required so `tray-icon` has a
    macOS run loop to attach to), `tokio` (background server thread's own
    runtime), `tracing`/`tracing-subscriber`, `sidecar-rust` as a path dep.
  - `src/supervisor.rs`: `Supervisor::spawn(config)` runs
    `sidecar_rust::serve` on a dedicated OS thread with its own
    multi-thread tokio runtime (the tao event loop must own the *main*
    thread for `tray-icon` on macOS, so the server can't run there).
    `Supervisor::shutdown()` fires a oneshot to the server's shutdown
    future and blocks (bounded 3s) until the listener-drop signal comes
    back, so callers know the port is released before they exit the
    process. This is the only non-GUI logic in the crate and is what
    `cargo test` covers headlessly (see Smoke below).
  - `src/main.rs`: loads `Config` (same validation as the standalone
    binary), spawns the `Supervisor` *before* creating the event loop
    (tray-icon requires the loop already running when the icon is built on
    macOS), builds the menu (`🐛 BugToPrompt ● Running (port N)` status
    line, disabled; separator; Settings; Open logs; separator; Quit),
    creates the tray icon on `NewEvents(StartCause::Init)`, sets
    `ActivationPolicy::Accessory` (menu-bar-only app, no Dock icon), and
    dispatches menu events: Quit → `Supervisor::shutdown()` then
    `ControlFlow::Exit`; Settings → no-op log line (ponytail-flagged,
    window lands with #58); Open logs → `open`s (creating if needed)
    `~/Library/Logs/BugToPrompt` in Finder.
  - Tray icon glyph: generated at build time (16×16 alpha-only circle,
    `with_icon_as_template(true)`) instead of a bundled asset file — no
    real app icon exists yet, packaging (#59) owns that.
  - `.gitignore`: `/target`, mirroring `sidecar-rust/.gitignore`.

## Gates — sidecar-rust (unchanged commands, run after the lib.rs/main.rs edit)

```
$ cargo fmt --check
(clean, no output)

$ cargo clippy --all-targets -- -D warnings
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.69s
(no warnings)

$ cargo build
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.11s

$ cargo test --lib --bins
running 16 tests (lib) ... test result: ok. 16 passed; 0 failed
running 1 test (bin) ... test result: ok. 1 passed; 0 failed

$ cargo test --test integration -- --test-threads=1
running 10 tests ... test result: ok. 10 passed; 0 failed
```

Note: `cargo test` with the default parallel runner intermittently hits a
**pre-existing** race in `tests/integration.rs`'s `ServerGuard::spawn`
(bind-an-ephemeral-port-then-drop-then-pass-to-child — two tests running in
parallel can grab the same port in that gap → `AddrInUse`). Reproduced with
`--test-threads=1` (deterministic pass, shown above) vs. default (occasional
`AddrInUse` panic in a spawned child, unrelated to this issue's changes —
the port-selection helper is untouched by #57 and out of my file-ownership
scope). Flagging for whoever owns `tests/integration.rs` next; not fixed
here.

## Gates — sidecar-tray (new crate)

```
$ cargo fmt --check
(clean, no output)

$ cargo clippy --all-targets -- -D warnings
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.30s
(no warnings; one collapsible-if caught and fixed during development)

$ cargo build
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 1.41s

$ cargo test
running 2 tests
test supervisor::tests::shutdown_is_idempotent ... ok
test supervisor::tests::serves_health_while_running_then_releases_the_port_on_shutdown ... ok
test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
```

`serves_health_while_running_then_releases_the_port_on_shutdown` is the
headless equivalent of the acceptance criteria: spawns the real
`Supervisor`/`sidecar_rust::serve` path on an ephemeral port, does a raw
HTTP GET to `/health` and asserts `200`, calls `shutdown()`, then asserts a
fresh `TcpListener::bind` on the same port succeeds immediately (proves the
listener was actually dropped, not just that the OS *would* reclaim it on
process exit).

## Smoke — manual `curl` against the real spawn path

Built a throwaway example (`examples/health_smoke.rs`, deleted before
commit — never part of the crate) that runs only `Supervisor::spawn` (no
tao/tray-icon GUI loop, so it works headlessly in this sandbox), backgrounded
it, and hit it with real `curl`:

```
$ ./target/debug/examples/health_smoke 54423 &
READY on port 54423

$ curl -s -w '\nHTTP_STATUS:%{http_code}\n' http://127.0.0.1:54423/health
{"gh":"unauthenticated","issues":false,"ok":true,"originAllowed":true,"repos":0,"transcription":"unconfigured"}
HTTP_STATUS:200

$ kill <pid>   # simulates process termination (Quit path terminates the process too)

$ curl -s -w '\nHTTP_STATUS:%{http_code}\n' http://127.0.0.1:54423/health
HTTP_STATUS:000   (curl exit 7 — connection refused, port released)
```

Matches all three behavioral acceptance criteria from the issue (server
reachable while running with the real `/health` contract, unreachable after
termination). The fourth criterion (menu bar icon with the three items
visible) requires a real macOS GUI session — see Deferred.

## Incident — shared-cwd path bug (mid-session)

The `read`/`write`/`edit` tools resolved relative paths against the shared
session cwd `~/Sites/bugtoprompt` (the main checkout), not this worktree,
even though `bash cd` correctly targeted the worktree. Caught it after an
`edit` warning; my `sidecar-rust/src/main.rs` edit, new `lib.rs`, and
`sidecar-tray/src/supervisor.rs` had landed uncommitted in the shared main
checkout (co-mingled with #55/#56's uncommitted work there). Nothing was
committed to `main` — reverted my three files there
(`git checkout -- sidecar-rust/src/main.rs`, removed `lib.rs`,
`rm -rf sidecar-tray`), redid all of it in this worktree using **absolute**
paths, and re-ran every gate above from the corrected state. Flagged to the
conductor and both sibling workers over `hub`; confirmed clean before
resuming (see conductor's "Recovery confirmed" go-ahead).
