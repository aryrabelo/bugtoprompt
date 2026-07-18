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

/// Directory `uv` installs `uvx` into (`~/.local/bin`). Used to re-probe right
/// after an install, before the updated PATH is visible to this already-running
/// process (finding #8).
fn uv_install_bin_dir() -> Option<std::path::PathBuf> {
    std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join(".local").join("bin"))
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

/// Re-probe `uvx` with `~/.local/bin` prepended to PATH so a just-installed
/// binary is found even though this process's inherited PATH predates it.
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

/// Install `uv` (PRD §6) as separate, individually-checked steps: download the
/// pinned installer, verify its SHA-256, then execute it. A failed or tampered
/// download can no longer be reported as success (finding #7), and the
/// post-install probe is PATH-aware (finding #8).
pub fn spawn_uvx_install(tx: Sender<Worker>) {
    use std::io::{BufRead, BufReader};
    use std::process::{Command, Stdio};

    thread::spawn(move || {
        let send = |line: String| {
            let _ = tx.send(Worker::InstallLine(line));
        };

        // 1. Download the pinned installer to a temp file (checked).
        send(format!("Downloading uv {UV_VERSION} installer…"));
        let tmp =
            std::env::temp_dir().join(format!("bugtoprompt-uv-install-{}.sh", std::process::id()));
        match Command::new("curl")
            .args(["-fLsS", UV_INSTALL_URL, "-o"])
            .arg(&tmp)
            .status()
        {
            Ok(s) if s.success() => {}
            Ok(s) => {
                send(format!("download failed: curl exited with {s}"));
                let _ = std::fs::remove_file(&tmp);
                return;
            }
            Err(err) => {
                send(format!("download failed: {err}"));
                return;
            }
        }

        // 2. Verify the checksum BEFORE executing (finding #4).
        let bytes = match std::fs::read(&tmp) {
            Ok(b) => b,
            Err(err) => {
                send(format!("could not read installer: {err}"));
                let _ = std::fs::remove_file(&tmp);
                return;
            }
        };
        let digest = sha256_hex(&bytes);
        if digest != UV_INSTALL_SHA256 {
            send(format!(
                "checksum mismatch — refusing to run installer (expected {UV_INSTALL_SHA256}, got {digest})"
            ));
            let _ = std::fs::remove_file(&tmp);
            return;
        }
        send("Checksum verified. Running installer…".to_string());

        // 3. Execute the verified script (checked). stdout + stderr are drained
        //    concurrently so neither pipe can fill and deadlock the child.
        let mut child = match Command::new("sh")
            .arg(&tmp)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
        {
            Ok(c) => c,
            Err(err) => {
                send(format!("failed to start installer: {err}"));
                let _ = std::fs::remove_file(&tmp);
                return;
            }
        };
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
        let _ = std::fs::remove_file(&tmp);
        if ok {
            send("✓ uv installed".to_string());
        } else {
            send("installer failed".to_string());
        }

        // 4. Re-probe with a PATH that includes the new install dir (finding #8).
        let _ = tx.send(Worker::Uvx(probe_uvx_after_install()));
    });
}
