use std::net::SocketAddr;

use axum::serve;
use tokio::signal;
use tracing::{info, warn};

use crate::app::build_app;
use crate::config::Config;
use crate::preflight::{
    detect_gh_state, detect_local_engine, detect_transcription_state,
    resolve_transcription_provider,
};
use crate::state::AppState;

mod app;
mod config;
mod handlers;
mod mw;
mod preflight;
mod security;
mod state;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let config = Config::load();

    if config.issue_mode && config.targets.is_empty() {
        eprintln!(
            "bugtoprompt: issue mode enabled but no repository is configured (set BUGTOPROMPT_REPOS or config.repos)."
        );
        std::process::exit(1);
    }

    let state = AppState::new(config.clone());

    // Resolve `gh` and local transcription engine in the BACKGROUND so a slow
    // or hung CLI probe never delays the HTTP listener. Mirrors
    // github-issue-service.mjs:727-762.
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

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("failed to bind server");
    serve(listener, build_app(state))
        .with_graceful_shutdown(shutdown_signal())
        .await
        .expect("server failed");
}

async fn shutdown_signal() {
    let ctrl_c = async {
        signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    let terminate = async {
        #[cfg(unix)]
        {
            signal::unix::signal(signal::unix::SignalKind::terminate())
                .expect("failed to install signal handler")
                .recv()
                .await;
        }
        #[cfg(not(unix))]
        {
            std::future::pending::<()>().await;
        }
    };

    tokio::select! {
        _ = ctrl_c => warn!("received SIGINT, shutting down"),
        _ = terminate => warn!("received SIGTERM, shutting down"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn issue_mode_requires_targets() {
        // Node reference fail-fast: issue mode is invalid without targets.
        let ok = |issue_mode: bool, has_targets: bool| !issue_mode || has_targets;
        assert!(!ok(true, false)); // issue mode + no targets => invalid
        assert!(ok(true, true)); // issue mode + targets => ok
        assert!(ok(false, false)); // no issue mode => ok regardless
                                   // The loaded default config must satisfy the same predicate.
        let cfg = Config::load();
        assert!(ok(cfg.issue_mode, !cfg.targets.is_empty()));
    }
}
