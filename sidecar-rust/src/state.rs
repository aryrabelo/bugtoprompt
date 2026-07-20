use std::sync::Arc;

use parking_lot::{Mutex, RwLock};

use crate::config::Config;
use crate::preflight::{GhState, TranscriptionState};

/// Shared server state. `Config` is immutable for the process lifetime;
/// `gh_state`/`transcription_*` are updated once each by their background
/// probe (see `main.rs`), mirroring the Node reference's plain mutable
/// module-level variables.
#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub gh_state: Arc<RwLock<GhState>>,
    pub transcription_provider: Arc<RwLock<&'static str>>,
    pub transcription_state: Arc<RwLock<TranscriptionState>>,
    /// Serializes the `/artifact` read-guard-through-write critical section so
    /// two concurrent saves for the same session cannot both pass the
    /// no-downgrade guard and then interleave their writes (cubic #133 P1).
    /// `tokio::sync::Mutex` (not parking_lot) because this section crosses
    /// `.await`. ponytail: one global lock — a localhost single-user sidecar
    /// has ~no concurrent same-session saves; go per-session only if throughput
    /// ever matters.
    pub artifact_save_lock: Arc<tokio::sync::Mutex<()>>,
}

impl AppState {
    pub fn new(config: Config) -> Self {
        Self {
            config: Arc::new(config),
            gh_state: Arc::new(RwLock::new(GhState::Pending)),
            transcription_provider: Arc::new(RwLock::new("unconfigured")),
            transcription_state: Arc::new(RwLock::new(TranscriptionState::Unconfigured)),
            artifact_save_lock: Arc::new(tokio::sync::Mutex::new(())),
        }
    }

    /// A helper to mutate state during the background probe phase, avoiding
    /// exposing Arc<RwLock> internals to callers that only need one write.
    pub fn update_transcription(&self, provider: &'static str, state: TranscriptionState) {
        *self.transcription_provider.write() = provider;
        *self.transcription_state.write() = state;
    }

    pub fn update_gh_state(&self, state: GhState) {
        *self.gh_state.write() = state;
    }
}

// Safety check: the Mutex here is only used for a synchronous lock held
// across a small assignment; the RwLock above is also synchronous because the
// critical section never crosses .await. parking_lot is used per project rules.
#[allow(dead_code)]
type _ParkingLotMutex = Mutex<()>;
