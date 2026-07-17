//! Library surface for embedding the sidecar HTTP server in a host process
//! (the `sidecar-tray` menu-bar app, issue #57) instead of running it as a
//! standalone binary. `src/main.rs` is a thin wrapper around [`serve`] using
//! Ctrl+C/SIGTERM as its shutdown signal; an embedding app supplies its own
//! shutdown future (e.g. a channel fired by a tray "Quit" menu item).

use std::future::Future;
use std::net::SocketAddr;

use tracing::info;

use crate::app::build_app;
use crate::config::Config;
use crate::preflight::{
    detect_gh_state, detect_local_engine, detect_transcription_state,
    resolve_transcription_provider,
};
use crate::state::AppState;

pub mod app;
pub mod config;
pub mod gh;
pub mod handlers;
pub mod mw;
pub mod preflight;
pub mod security;
pub mod state;
pub mod transcribe;

/// Bind the axum server on `config.host:config.port` and serve until
/// `shutdown` resolves. Spawns the same background `gh`/transcription
/// preflight probes the standalone binary spawns (mirrors
/// `github-issue-service.mjs:727-762`) so a slow CLI probe never delays the
/// HTTP listener.
pub async fn serve(
    config: Config,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> std::io::Result<()> {
    let state = AppState::new(config.clone());

    let gh_state = state.clone();
    tokio::spawn(async move {
        let s = detect_gh_state().await;
        gh_state.update_gh_state(s);
    });

    let transcription_state = state.clone();
    let assemblyai_key = config.assemblyai_key.clone();
    tokio::spawn(async move {
        let local_ready = detect_local_engine().await;
        let provider = resolve_transcription_provider(local_ready, assemblyai_key.as_deref());
        let state_value = detect_transcription_state(local_ready, assemblyai_key.as_deref());
        transcription_state.update_transcription(provider, state_value);
    });

    let addr: SocketAddr = format!("{}:{}", config.host, config.port)
        .parse()
        .expect("host:port must be a valid socket address");

    info!(
        "bugtoprompt server on http://{} (issue mode {}; {} repo target(s))",
        addr,
        if config.issue_mode {
            "ENABLED"
        } else {
            "disabled"
        },
        config.targets.len()
    );

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, build_app(state))
        .with_graceful_shutdown(shutdown)
        .await
}
