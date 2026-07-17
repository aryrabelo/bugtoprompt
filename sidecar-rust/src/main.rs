use tokio::signal;
use tracing::warn;

use sidecar_rust::config::Config;

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

    sidecar_rust::serve(config, shutdown_signal())
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
