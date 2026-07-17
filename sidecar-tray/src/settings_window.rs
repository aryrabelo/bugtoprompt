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

use sidecar_rust::preflight::UV_INSTALL_COMMAND;

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

/// Run the `uv` installer (PRD §6 one-click install), streaming merged output
/// lines back, then re-probe so the status flips to ready on success. Output
/// is merged (`2>&1`) and drained from a single stream so a chatty `curl`
/// progress bar on stderr can never fill a pipe and deadlock the child.
pub fn spawn_uvx_install(tx: Sender<Worker>) {
    use std::io::{BufRead, BufReader};
    use std::process::{Command, Stdio};

    thread::spawn(move || {
        let _ = tx.send(Worker::InstallLine(format!("$ {UV_INSTALL_COMMAND}")));
        let child = Command::new("sh")
            .arg("-c")
            .arg(format!("{UV_INSTALL_COMMAND} 2>&1"))
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn();
        let mut child = match child {
            Ok(c) => c,
            Err(err) => {
                let _ = tx.send(Worker::InstallLine(format!(
                    "failed to start installer: {err}"
                )));
                return;
            }
        };
        if let Some(out) = child.stdout.take() {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                let _ = tx.send(Worker::InstallLine(line));
            }
        }
        match child.wait() {
            Ok(status) if status.success() => {
                let _ = tx.send(Worker::InstallLine("✓ uv installed".to_string()));
            }
            Ok(status) => {
                let _ = tx.send(Worker::InstallLine(format!("installer exited: {status}")));
            }
            Err(err) => {
                let _ = tx.send(Worker::InstallLine(format!("installer wait failed: {err}")));
            }
        }
        // Re-probe regardless so the indicator reflects reality.
        let ready = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map(|rt| rt.block_on(sidecar_rust::preflight::detect_local_engine()))
            .unwrap_or(false);
        let _ = tx.send(Worker::Uvx(ready));
    });
}
