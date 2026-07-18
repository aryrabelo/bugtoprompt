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

/// Which backend serves `POST /transcribe`. An explicit `engine_pref`
/// ("local" | "cloud") is honored when it is actually available; otherwise the
/// default precedence applies (local over a configured AssemblyAI key). Real
/// routing lands in #55/#60; #54 only needs this for `GET /bugtoprompt/config`.
pub fn resolve_transcription_provider(
    local_ready: bool,
    assemblyai_key: Option<&str>,
    engine_pref: Option<&str>,
) -> &'static str {
    let has_key = assemblyai_key.is_some_and(|k| !k.is_empty());
    match engine_pref {
        Some("cloud") if has_key => return "assemblyai",
        Some("local") if local_ready => return "local",
        _ => {}
    }
    if local_ready {
        return "local";
    }
    if has_key {
        return "assemblyai";
    }
    "unconfigured"
}

/// Resolve `GET /health`'s `transcription` field, honoring the same explicit
/// `engine_pref` as [`resolve_transcription_provider`]: cloud pref + key →
/// "ready", local pref + engine ready → "local", else default precedence.
pub fn detect_transcription_state(
    local_ready: bool,
    assemblyai_key: Option<&str>,
    engine_pref: Option<&str>,
) -> TranscriptionState {
    let has_key = assemblyai_key.is_some_and(|k| !k.is_empty());
    match engine_pref {
        Some("cloud") if has_key => return TranscriptionState::Ready,
        Some("local") if local_ready => return TranscriptionState::Local,
        _ => {}
    }
    if local_ready {
        return TranscriptionState::Local;
    }
    if has_key {
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
    fn transcription_provider_prefers_local_by_default() {
        assert_eq!(
            resolve_transcription_provider(true, Some("key"), None),
            "local"
        );
        assert_eq!(
            resolve_transcription_provider(false, Some("key"), None),
            "assemblyai"
        );
        assert_eq!(
            resolve_transcription_provider(false, None, None),
            "unconfigured"
        );
        assert_eq!(
            resolve_transcription_provider(false, Some(""), None),
            "unconfigured"
        );
    }

    #[test]
    fn transcription_provider_honors_explicit_engine_pref() {
        // Cloud preferred over a ready local engine when a key exists.
        assert_eq!(
            resolve_transcription_provider(true, Some("key"), Some("cloud")),
            "assemblyai"
        );
        // Cloud pref with no key falls back to local.
        assert_eq!(
            resolve_transcription_provider(true, None, Some("cloud")),
            "local"
        );
        // Local pref is honored.
        assert_eq!(
            resolve_transcription_provider(true, Some("key"), Some("local")),
            "local"
        );
        // Health state mirrors the same preference.
        assert_eq!(
            detect_transcription_state(true, Some("key"), Some("cloud")),
            TranscriptionState::Ready
        );
        assert_eq!(
            detect_transcription_state(true, Some("key"), Some("local")),
            TranscriptionState::Local
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
