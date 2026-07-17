//! Runs the embedded `sidecar_rust` HTTP server (issue #54) on a dedicated
//! OS thread with its own tokio runtime, decoupled from the tray/menu event
//! loop — which must own the main thread for `tray-icon` to work on macOS
//! (see `main.rs`). This is the only non-GUI piece of the tray shell, so
//! it's the part covered by `cargo test` (issue #57 acceptance: headless
//! build/test, manual GUI smoke only).

use std::sync::mpsc;
use std::time::Duration;

use sidecar_rust::config::Config;
use tokio::sync::oneshot;

/// Bound the wait for a graceful shutdown. Process exit reclaims the port
/// regardless, this only keeps `shutdown()` from hanging forever if the
/// server thread wedges.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(3);

/// Handle to the background server thread. Dropping it does *not* stop the
/// server — call [`Supervisor::shutdown`] explicitly (the tray's "Quit"
/// handler does this before exiting the event loop).
pub struct Supervisor {
    shutdown_tx: Option<oneshot::Sender<()>>,
    done_rx: mpsc::Receiver<()>,
    _thread: std::thread::JoinHandle<()>,
}

impl Supervisor {
    /// Spawn the sidecar server. Must be called before the tao event loop
    /// takes over the main thread.
    pub fn spawn(config: Config) -> Self {
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        let (done_tx, done_rx) = mpsc::channel::<()>();

        let thread = std::thread::Builder::new()
            .name("sidecar-server".into())
            .spawn(move || {
                let rt = tokio::runtime::Builder::new_multi_thread()
                    .enable_all()
                    .build()
                    .expect("failed to build tokio runtime for sidecar server");
                rt.block_on(async move {
                    let shutdown = async {
                        let _ = shutdown_rx.await;
                    };
                    if let Err(err) = sidecar_rust::serve(config, shutdown).await {
                        tracing::error!("sidecar server exited with error: {err}");
                    }
                });
                // Server thread only returns once the listener is dropped —
                // the port is guaranteed free by the time this fires.
                let _ = done_tx.send(());
            })
            .expect("failed to spawn sidecar server thread");

        Self {
            shutdown_tx: Some(shutdown_tx),
            done_rx,
            _thread: thread,
        }
    }

    /// Signal graceful shutdown and block (briefly, bounded) until the
    /// listener is released. Safe to call more than once; only the first
    /// call has an effect.
    pub fn shutdown(&mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
            let _ = self.done_rx.recv_timeout(SHUTDOWN_GRACE);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::io::{Read, Write};
    use std::net::TcpStream;

    fn free_port() -> u16 {
        std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port()
    }

    fn get(port: u16, path: &str) -> std::io::Result<String> {
        let mut stream = TcpStream::connect(("127.0.0.1", port))?;
        stream.write_all(
            format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
                .as_bytes(),
        )?;
        let mut resp = String::new();
        stream.read_to_string(&mut resp)?;
        Ok(resp)
    }

    fn wait_for_ready(port: u16) {
        for _ in 0..100 {
            if get(port, "/health").is_ok_and(|r| r.contains("200")) {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        panic!("server did not become ready on port {port}");
    }

    fn test_config(port: u16) -> Config {
        Config {
            host: "127.0.0.1".to_string(),
            port,
            issue_mode: false,
            targets: Vec::new(),
            project_id: "test".to_string(),
            screenshot_mode: None,
            env: None,
            enabled_modes: vec!["clipboard", "download"],
            default_mode: "clipboard".to_string(),
            allowed_origins: HashSet::new(),
            token: None,
            assemblyai_key: None,
            captures_root: std::env::temp_dir()
                .join("sidecar-tray-tests")
                .join(port.to_string()),
        }
    }

    #[test]
    fn serves_health_while_running_then_releases_the_port_on_shutdown() {
        let port = free_port();
        let mut supervisor = Supervisor::spawn(test_config(port));
        wait_for_ready(port);

        let health = get(port, "/health").expect("server should respond while running");
        assert!(
            health.contains("200"),
            "unexpected /health response: {health}"
        );

        supervisor.shutdown();

        // A fresh bind on the same port must succeed immediately — proves
        // the listener was actually dropped, not just that the process
        // *would* release it on exit.
        let relisten = std::net::TcpListener::bind(("127.0.0.1", port));
        assert!(
            relisten.is_ok(),
            "port {port} must be free after Supervisor::shutdown()"
        );
    }

    #[test]
    fn shutdown_is_idempotent() {
        let port = free_port();
        let mut supervisor = Supervisor::spawn(test_config(port));
        wait_for_ready(port);
        supervisor.shutdown();
        supervisor.shutdown(); // second call must not panic or hang
    }
}
