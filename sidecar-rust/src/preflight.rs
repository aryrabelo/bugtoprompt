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

/// Shell one-liner the Settings UI runs when `uvx` is missing (PRD §6):
/// installs Astral's `uv` (which provides `uvx`).
pub const UV_INSTALL_COMMAND: &str = "curl -LsSf https://astral.sh/uv/install.sh | sh";

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
    Ready,
    Local,
    Unconfigured,
}

impl TranscriptionState {
    pub fn wire(self) -> &'static str {
        match self {
            TranscriptionState::Ready => "ready",
            TranscriptionState::Local => "local",
            TranscriptionState::Unconfigured => "unconfigured",
        }
    }
}

/// Which backend serves `POST /transcribe` — local takes precedence over a
/// configured AssemblyAI key. Real routing lands in #55; #54 only needs this
/// for `GET /bugtoprompt/config`'s `transcriptionProvider` field.
pub fn resolve_transcription_provider(
    local_ready: bool,
    assemblyai_key: Option<&str>,
) -> &'static str {
    if local_ready {
        return "local";
    }
    if assemblyai_key.is_some_and(|k| !k.is_empty()) {
        return "assemblyai";
    }
    "unconfigured"
}

/// Resolve `GET /health`'s `transcription` field: local engine ready →
/// "local" (LITE default), else a configured cloud key → "ready", else
/// "unconfigured".
pub fn detect_transcription_state(
    local_ready: bool,
    assemblyai_key: Option<&str>,
) -> TranscriptionState {
    if local_ready {
        return TranscriptionState::Local;
    }
    if assemblyai_key.is_some_and(|k| !k.is_empty()) {
        return TranscriptionState::Ready;
    }
    TranscriptionState::Unconfigured
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
    fn transcription_provider_prefers_local() {
        assert_eq!(resolve_transcription_provider(true, Some("key")), "local");
        assert_eq!(
            resolve_transcription_provider(false, Some("key")),
            "assemblyai"
        );
        assert_eq!(resolve_transcription_provider(false, None), "unconfigured");
        assert_eq!(
            resolve_transcription_provider(false, Some("")),
            "unconfigured"
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
