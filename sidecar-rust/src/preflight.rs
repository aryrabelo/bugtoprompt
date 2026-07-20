//! Background health probes mirroring `server/service-preflight.mjs` +
//! `server/local-transcribe.mjs`'s `detectLocalEngine`. Never surface a
//! token, only ready/missing/unauthenticated (or the transient `Pending`
//! sentinel held until the probe resolves).

use std::time::Duration;

use serde_json::{json, Value};
use tokio::process::Command;
use tokio::time::timeout;

const GH_PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const LOCAL_ENGINE_PROBE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GhState {
    Pending,
    Ready,
    Missing,
    Unauthenticated,
}

impl GhState {
    /// Coerce the internal probe state into the wire contract value. The
    /// transient `Pending` sentinel (before the background probe resolves)
    /// reports the non-alarming "unauthenticated" rather than "missing".
    pub fn published(self) -> &'static str {
        match self {
            GhState::Ready => "ready",
            GhState::Missing => "missing",
            GhState::Unauthenticated | GhState::Pending => "unauthenticated",
        }
    }
}

/// Resolve `gh` CLI availability + auth without ever spawning a process that
/// could hang the listener — each probe is bounded by a 5s timeout.
pub async fn detect_gh_state() -> GhState {
    if !run_ok("gh", &["--version"], GH_PROBE_TIMEOUT).await {
        return GhState::Missing;
    }
    if run_ok("gh", &["auth", "status", "--active"], GH_PROBE_TIMEOUT).await {
        GhState::Ready
    } else {
        GhState::Unauthenticated
    }
}

/// Pinned uv version whose installer we download and verify (finding #4). Bump
/// deliberately, together with `UV_INSTALL_SHA256`.
pub const UV_VERSION: &str = "0.11.29";

/// Versioned (immutable) installer URL for [`UV_VERSION`]. The unversioned
/// `https://astral.sh/uv/install.sh` is a moving target and must not be piped
/// straight into a shell.
pub const UV_INSTALL_URL: &str = "https://astral.sh/uv/0.11.29/install.sh";

/// SHA-256 of the installer served at [`UV_INSTALL_URL`]. The Settings UI
/// downloads the script, verifies this digest, and only then executes it — so a
/// rewritten or man-in-the-middled installer never runs.
pub const UV_INSTALL_SHA256: &str =
    "504a79fd2ed0dcd47e7f04f0792cfd0871f62e24a7fe40fa8ae0f563a369f2bd";

/// Probe whether the parakeet-mlx CLI is available through `uvx`.
pub async fn detect_local_engine() -> bool {
    run_ok(
        "uvx",
        &["parakeet-mlx", "--version"],
        LOCAL_ENGINE_PROBE_TIMEOUT,
    )
    .await
}

async fn run_ok(cmd: &str, args: &[&str], bound: Duration) -> bool {
    let fut = Command::new(cmd).args(args).kill_on_drop(true).output();
    matches!(timeout(bound, fut).await, Ok(Ok(output)) if output.status.success())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TranscriptionState {
    Local,
    Unconfigured,
}

impl TranscriptionState {
    pub fn wire(self) -> &'static str {
        match self {
            TranscriptionState::Local => "local",
            TranscriptionState::Unconfigured => "unconfigured",
        }
    }
}

/// Which backend serves `POST /transcribe` — the wire form of the health
/// transcription state. Only local Parakeet exists in the Lite sidecar; cloud
/// transcription is a Pro feature served server-side by api.bugtoprompt.com,
/// never here. Derived from [`detect_transcription_state`] so the two can't
/// drift apart.
pub fn resolve_transcription_provider(local_ready: bool) -> &'static str {
    detect_transcription_state(local_ready).wire()
}

/// Resolve `GET /health`'s `transcription` field: `Local` when the local
/// engine is ready, else `Unconfigured`.
pub fn detect_transcription_state(local_ready: bool) -> TranscriptionState {
    if local_ready {
        TranscriptionState::Local
    } else {
        TranscriptionState::Unconfigured
    }
}

/// Assemble the exact `/health` contract:
/// `{ ok: true, issues, repos, gh, transcription, originAllowed }`.
pub fn build_health_payload(
    issues: bool,
    repos: usize,
    gh: &str,
    transcription: &str,
    origin_allowed: bool,
) -> Value {
    json!({
        "ok": true,
        "issues": issues,
        "repos": repos,
        "gh": gh,
        "transcription": transcription,
        "originAllowed": origin_allowed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gh_state_publishes_pending_as_unauthenticated() {
        assert_eq!(GhState::Pending.published(), "unauthenticated");
        assert_eq!(GhState::Ready.published(), "ready");
        assert_eq!(GhState::Missing.published(), "missing");
        assert_eq!(GhState::Unauthenticated.published(), "unauthenticated");
    }

    #[test]
    fn transcription_provider_reflects_local_readiness() {
        assert_eq!(resolve_transcription_provider(true), "local");
        assert_eq!(resolve_transcription_provider(false), "unconfigured");
    }

    #[test]
    fn transcription_state_reflects_local_readiness() {
        assert_eq!(detect_transcription_state(true), TranscriptionState::Local);
        assert_eq!(
            detect_transcription_state(false),
            TranscriptionState::Unconfigured
        );
    }

    #[test]
    fn health_payload_has_the_exact_shape() {
        let body = build_health_payload(true, 2, "ready", "local", true);
        assert_eq!(
            body,
            json!({
                "ok": true,
                "issues": true,
                "repos": 2,
                "gh": "ready",
                "transcription": "local",
                "originAllowed": true,
            })
        );
    }
}
