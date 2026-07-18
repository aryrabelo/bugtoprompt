//! The macOS Settings webview shell (issue #58, PRD §8/§11 "Tauri webview").
//!
//! Uses `wry` — the webview engine Tauri itself is built on — attached to the
//! tray's existing `tao` event loop, rather than the full Tauri app framework
//! (which would fight the `tao`/`tray-icon` main-thread model this crate
//! already owns; see `main.rs`). This is the GUI shell: it holds no business
//! logic (that lives in the headlessly-tested `settings_ui`), so it is covered
//! by manual GUI smoke only, matching the #57 model.

use std::sync::mpsc::Sender;
use std::thread;

use tao::dpi::LogicalSize;
use tao::event_loop::EventLoopWindowTarget;
use tao::window::{Window, WindowBuilder};
use wry::{WebView, WebViewBuilder};

use sidecar_rust::preflight::{UV_INSTALL_SHA256, UV_INSTALL_URL, UV_VERSION};

const SETTINGS_HTML: &str = include_str!("../settings.html");

/// Results from background worker threads, delivered to the event loop so it
/// can push them into the webview on the main thread.
#[derive(Debug)]
pub enum Worker {
    /// uvx probe finished: `true` = the local engine is available.
    Uvx(bool),
    /// A line of `uv` installer output.
    InstallLine(String),
}

/// A live settings window: the webview and the `tao` window backing it. Field
/// order matters — the webview is dropped before the window it borrows.
pub struct SettingsWindow {
    webview: WebView,
    _window: Window,
}

impl SettingsWindow {
    /// Create the window and load the settings UI. IPC messages from the
    /// webview are forwarded verbatim to `ipc_tx` for the event loop to parse.
    pub fn open(
        target: &EventLoopWindowTarget<()>,
        ipc_tx: Sender<String>,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        let window = WindowBuilder::new()
            .with_title("BugToPrompt Settings")
            .with_inner_size(LogicalSize::new(480.0, 640.0))
            .build(target)?;

        let webview = WebViewBuilder::new()
            .with_html(SETTINGS_HTML)
            .with_ipc_handler(move |req: wry::http::Request<String>| {
                let _ = ipc_tx.send(req.into_body());
            })
            .build(&window)?;

        Ok(Self {
            webview,
            _window: window,
        })
    }

    fn eval(&self, script: &str) {
        if let Err(err) = self.webview.evaluate_script(script) {
            tracing::warn!("settings webview eval failed: {err}");
        }
    }

    /// Push the full UI state JSON (already valid JSON) into the webview.
    pub fn push_state(&self, state_json: &str) {
        self.eval(&format!("window.__btp&&window.__btp.onState({state_json})"));
    }

    pub fn push_uvx(&self, status: &str) {
        let arg = serde_json::to_string(status).unwrap_or_else(|_| "\"checking\"".into());
        self.eval(&format!("window.__btp&&window.__btp.onUvxStatus({arg})"));
    }

    pub fn push_install_line(&self, line: &str) {
        let arg = serde_json::to_string(line).unwrap_or_else(|_| "\"\"".into());
        self.eval(&format!(
            "window.__btp&&window.__btp.onInstallProgress({arg})"
        ));
    }

    pub fn push_saved(&self, ok: bool) {
        self.eval(&format!("window.__btp&&window.__btp.onSaved({ok})"));
    }
}

/// Probe `uvx` availability off the main thread (reuses the #55 async probe via
/// a throwaway runtime) and report the result.
pub fn spawn_uvx_probe(tx: Sender<Worker>) {
    thread::spawn(move || {
        let ready = match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(rt) => rt.block_on(sidecar_rust::preflight::detect_local_engine()),
            Err(err) => {
                tracing::warn!("uvx probe runtime failed: {err}");
                false
            }
        };
        let _ = tx.send(Worker::Uvx(ready));
    });
}

/// Directory `uv` installs `uvx` into. Mirrors the pinned installer's
/// (0.11.29) install-dir precedence — `UV_INSTALL_DIR`, then
/// `CARGO_DIST_FORCE_INSTALL_DIR`, then `UV_UNMANAGED_INSTALL`, then
/// `XDG_BIN_HOME`, then `$XDG_DATA_HOME/../bin`, then `$HOME/.local/bin` — so a
/// probe right after an install looks where the installer actually placed the
/// binary. The three force vars use the installer's "flat" layout (the dir
/// itself).
fn uv_install_bin_dir() -> Option<std::path::PathBuf> {
    resolve_uv_install_bin_dir(|k| std::env::var_os(k))
}

fn resolve_uv_install_bin_dir(
    get: impl Fn(&str) -> Option<std::ffi::OsString>,
) -> Option<std::path::PathBuf> {
    use std::path::PathBuf;
    // `-n` semantics: an empty env var is treated as unset, like the installer.
    let non_empty = |key: &str| get(key).filter(|v| !v.is_empty());
    // Forced install dirs (flat layout: the binary lands in the dir itself),
    // checked in the installer's order.
    for key in [
        "UV_INSTALL_DIR",
        "CARGO_DIST_FORCE_INSTALL_DIR",
        "UV_UNMANAGED_INSTALL",
    ] {
        if let Some(dir) = non_empty(key) {
            return Some(PathBuf::from(dir));
        }
    }
    if let Some(dir) = non_empty("XDG_BIN_HOME") {
        return Some(PathBuf::from(dir));
    }
    if let Some(dir) = non_empty("XDG_DATA_HOME") {
        return Some(PathBuf::from(dir).join("..").join("bin"));
    }
    non_empty("HOME").map(|h| PathBuf::from(h).join(".local").join("bin"))
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Re-probe `uvx` with the installer's target bin dir prepended to PATH so a
/// just-installed binary is found even though this process's inherited PATH
/// predates it.
fn probe_uvx_after_install() -> bool {
    let Ok(rt) = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    else {
        return false;
    };
    rt.block_on(async {
        // Mirrors preflight::detect_local_engine, but with an augmented PATH.
        let mut cmd = tokio::process::Command::new("uvx");
        cmd.args(["parakeet-mlx", "--version"]).kill_on_drop(true);
        if let Some(dir) = uv_install_bin_dir() {
            let existing = std::env::var_os("PATH").unwrap_or_default();
            let mut paths: Vec<std::path::PathBuf> = std::env::split_paths(&existing).collect();
            paths.insert(0, dir);
            if let Ok(joined) = std::env::join_paths(paths) {
                cmd.env("PATH", joined);
            }
        }
        matches!(
            tokio::time::timeout(std::time::Duration::from_secs(5), cmd.output()).await,
            Ok(Ok(out)) if out.status.success()
        )
    })
}

/// Install `uv` (PRD §6): download the pinned installer into memory, verify
/// its SHA-256, then execute the *exact* verified bytes by piping them to
/// `sh -s` stdin. There is no on-disk installer file to swap between hashing
/// and execution, so the checksum can't be bypassed by a temp-file race. A
/// completion status is emitted on every exit path so the install button can
/// never stick on "Installing…", and the post-install probe is PATH-aware.
pub fn spawn_uvx_install(tx: Sender<Worker>) {
    use std::io::{BufRead, BufReader, Write};
    use std::process::{Command, Stdio};

    thread::spawn(move || {
        let send = |line: String| {
            let _ = tx.send(Worker::InstallLine(line));
        };

        // Runs download → verify → execute, returning whether the installer
        // completed successfully. Every failure sends a diagnostic line and
        // returns false; the status event below still fires regardless.
        let run = || -> bool {
            send(format!("Downloading uv {UV_VERSION} installer…"));
            let script = match Command::new("curl")
                .args(["-fLsS", UV_INSTALL_URL])
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .output()
            {
                Ok(out) if out.status.success() => out.stdout,
                Ok(out) => {
                    send(format!(
                        "download failed: curl exited with {} ({})",
                        out.status,
                        String::from_utf8_lossy(&out.stderr).trim()
                    ));
                    return false;
                }
                Err(err) => {
                    send(format!("download failed: {err}"));
                    return false;
                }
            };

            // Verify the checksum of the exact bytes we are about to execute.
            let digest = sha256_hex(&script);
            if digest != UV_INSTALL_SHA256 {
                send(format!(
                    "checksum mismatch — refusing to run installer (expected {UV_INSTALL_SHA256}, got {digest})"
                ));
                return false;
            }
            send("Checksum verified. Running installer…".to_string());

            // Feed the verified bytes straight to `sh -s`: the shell runs
            // exactly what we hashed — never a file an attacker could swap
            // after verification (no reopened temp path).
            let mut child = match Command::new("sh")
                .arg("-s")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
            {
                Ok(c) => c,
                Err(err) => {
                    send(format!("failed to start installer: {err}"));
                    return false;
                }
            };

            // Write the script on a dedicated thread so a large installer can't
            // deadlock against the stdout/stderr draining below.
            let stdin = child.stdin.take();
            let stdin_writer = thread::spawn(move || {
                if let Some(mut s) = stdin {
                    let _ = s.write_all(&script);
                    // dropping `s` closes stdin → EOF for `sh -s`.
                }
            });
            if let Some(err_out) = child.stderr.take() {
                let tx_err = tx.clone();
                thread::spawn(move || {
                    for line in BufReader::new(err_out).lines().map_while(Result::ok) {
                        let _ = tx_err.send(Worker::InstallLine(line));
                    }
                });
            }
            if let Some(out) = child.stdout.take() {
                for line in BufReader::new(out).lines().map_while(Result::ok) {
                    send(line);
                }
            }
            let ok = matches!(child.wait(), Ok(status) if status.success());
            let _ = stdin_writer.join();
            ok
        };

        let ok = run();
        send(if ok {
            "✓ uv installed".to_string()
        } else {
            "installer failed".to_string()
        });

        // Always resolve the UI status so the install button never sticks on
        // "Installing…": a PATH-aware re-probe on success, "missing" on failure
        // so the user can retry.
        let ready = ok && probe_uvx_after_install();
        let _ = tx.send(Worker::Uvx(ready));
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::ffi::OsString;
    use std::path::PathBuf;

    fn env_lookup(map: HashMap<&'static str, &'static str>) -> impl Fn(&str) -> Option<OsString> {
        move |k: &str| map.get(k).map(OsString::from)
    }

    #[test]
    fn install_dir_precedence_matches_uv_installer() {
        // UV_INSTALL_DIR wins outright.
        let m = HashMap::from([
            ("UV_INSTALL_DIR", "/opt/uv"),
            ("XDG_BIN_HOME", "/xdg/bin"),
            ("HOME", "/home/u"),
        ]);
        assert_eq!(
            resolve_uv_install_bin_dir(env_lookup(m)),
            Some(PathBuf::from("/opt/uv"))
        );

        // CARGO_DIST_FORCE_INSTALL_DIR is next when UV_INSTALL_DIR is unset,
        // ahead of XDG/HOME.
        let m = HashMap::from([
            ("CARGO_DIST_FORCE_INSTALL_DIR", "/forced"),
            ("XDG_BIN_HOME", "/xdg/bin"),
            ("HOME", "/home/u"),
        ]);
        assert_eq!(
            resolve_uv_install_bin_dir(env_lookup(m)),
            Some(PathBuf::from("/forced"))
        );

        // UV_UNMANAGED_INSTALL is used as the install dir (flat layout).
        let m = HashMap::from([
            ("UV_UNMANAGED_INSTALL", "/unmanaged"),
            ("XDG_BIN_HOME", "/xdg/bin"),
        ]);
        assert_eq!(
            resolve_uv_install_bin_dir(env_lookup(m)),
            Some(PathBuf::from("/unmanaged"))
        );

        // UV_INSTALL_DIR outranks both force overrides.
        let m = HashMap::from([
            ("UV_INSTALL_DIR", "/opt/uv"),
            ("CARGO_DIST_FORCE_INSTALL_DIR", "/forced"),
            ("UV_UNMANAGED_INSTALL", "/unmanaged"),
        ]);
        assert_eq!(
            resolve_uv_install_bin_dir(env_lookup(m)),
            Some(PathBuf::from("/opt/uv"))
        );

        // CARGO_DIST_FORCE_INSTALL_DIR outranks UV_UNMANAGED_INSTALL.
        let m = HashMap::from([
            ("CARGO_DIST_FORCE_INSTALL_DIR", "/forced"),
            ("UV_UNMANAGED_INSTALL", "/unmanaged"),
        ]);
        assert_eq!(
            resolve_uv_install_bin_dir(env_lookup(m)),
            Some(PathBuf::from("/forced"))
        );

        // then XDG_BIN_HOME.
        let m = HashMap::from([("XDG_BIN_HOME", "/xdg/bin"), ("XDG_DATA_HOME", "/xdg/data")]);
        assert_eq!(
            resolve_uv_install_bin_dir(env_lookup(m)),
            Some(PathBuf::from("/xdg/bin"))
        );

        // then $XDG_DATA_HOME/../bin.
        let m = HashMap::from([("XDG_DATA_HOME", "/xdg/data"), ("HOME", "/home/u")]);
        assert_eq!(
            resolve_uv_install_bin_dir(env_lookup(m)),
            Some(PathBuf::from("/xdg/data/../bin"))
        );

        // default to $HOME/.local/bin; an empty var is ignored (`-n`).
        let m = HashMap::from([("UV_INSTALL_DIR", ""), ("HOME", "/home/u")]);
        assert_eq!(
            resolve_uv_install_bin_dir(env_lookup(m)),
            Some(PathBuf::from("/home/u/.local/bin"))
        );
    }
}
