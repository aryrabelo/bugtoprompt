//! Retire the legacy Node LaunchAgent (issue #59).
//!
//! The old `bugtoprompt-server` shipped as a hand-installed LaunchAgent plist
//! (`~/Library/LaunchAgents/com.bugtoprompt.sidecar.plist`) that launchd starts
//! on login and binds to port 4127. The new tray app owns that port itself, so
//! if both were live they would double-bind it. On startup the tray calls
//! [`disable_legacy_launch_agent`] BEFORE it spawns its own server: it stops the
//! running legacy job and, only once it has POSITIVELY confirmed the job is no
//! longer loaded, renames the plist so launchd never reloads it at the next
//! login. Any state it cannot confirm — the job is still loaded, or launchd/the
//! plist could not be inspected — is treated as unsafe ([`LegacyDisable::StillRunning`]
//! / [`LegacyDisable::Unknown`]) and the plist is left untouched so the caller
//! can surface a clear error instead of racing into a doomed bind. The one-time
//! env import lives separately in [`crate::migrate`]; this module only tears the
//! old daemon down.

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::migrate::default_launch_agent_path;

/// Outcome of attempting to retire the legacy LaunchAgent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LegacyDisable {
    /// No legacy plist was found — nothing to do.
    NotPresent,
    /// The job was confirmed stopped and the plist renamed aside.
    Disabled,
    /// The job is still loaded after the unload attempt: the port is NOT free,
    /// so the plist was left in place. The caller must not bind the port.
    StillRunning,
    /// The job was stopped but the plist could not be renamed (fs error). Left
    /// active, launchd would reload it at the next login, so the caller must
    /// treat this as blocking rather than start a soon-to-collide second daemon.
    RenameFailed,
    /// The legacy job's state could not be determined — the plist was
    /// unparseable, or `launchctl` could not be run. Fail safe: assume it might
    /// be running rather than renaming its plist and starting beside it.
    Unknown,
}

/// Whether launchd currently has the legacy job loaded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum JobState {
    Loaded,
    NotLoaded,
    /// `launchctl` could not be run — the real state is unknown.
    Unknown,
}

/// Stop and permanently disable the legacy LaunchAgent at the default path.
/// Idempotent: once the plist is renamed, later calls return
/// [`LegacyDisable::NotPresent`].
pub fn disable_legacy_launch_agent() -> LegacyDisable {
    let Some(plist) = default_launch_agent_path() else {
        return LegacyDisable::NotPresent;
    };
    disable_legacy_launch_agent_at(&plist)
}

/// [`disable_legacy_launch_agent`] against an explicit plist path. Stops the
/// running job, RE-checks the final state, and only renames the plist when the
/// job is positively confirmed not loaded.
pub fn disable_legacy_launch_agent_at(plist: &Path) -> LegacyDisable {
    if !plist.exists() {
        return LegacyDisable::NotPresent;
    }
    // Without the Label we cannot verify whether the job is running; treat an
    // unparseable plist as UNKNOWN (fail safe) rather than assuming it is absent.
    let Some(label) = read_label(plist) else {
        tracing::error!(
            "legacy LaunchAgent plist {} is unreadable/unparseable; cannot verify it is stopped",
            plist.display()
        );
        return LegacyDisable::Unknown;
    };
    // Stop it if it is currently loaded (unload by path is a no-op otherwise).
    if job_state(&label) == JobState::Loaded {
        unload_job(plist);
    }
    // Re-query the FINAL state: only a job that is positively not loaded is safe
    // to disable. A still-loaded job (incl. one that (re)loaded during the race)
    // or an unknown state must not be renamed beside.
    match outcome_for_final_state(job_state(&label)) {
        Ok(()) => match rename_disabled(plist) {
            Ok(disabled) => {
                tracing::info!(
                    "disabled legacy LaunchAgent: {} -> {}",
                    plist.display(),
                    disabled.display()
                );
                LegacyDisable::Disabled
            }
            Err(err) => {
                tracing::warn!(
                    "legacy LaunchAgent stopped but its plist {} could not be renamed: {err}",
                    plist.display()
                );
                LegacyDisable::RenameFailed
            }
        },
        Err(outcome) => {
            tracing::error!(
                "legacy LaunchAgent {} is not confirmed stopped ({outcome:?}); leaving its plist in place",
                plist.display()
            );
            outcome
        }
    }
}

/// Map the legacy job's final state (after our stop attempt) to whether it is
/// safe to disable the plist. Only a positively-not-loaded job is safe; a still
/// loaded job (findings #1: incl. a load that raced our first query) or an
/// undeterminable state (finding #3) is a fail-safe block.
fn outcome_for_final_state(state: JobState) -> Result<(), LegacyDisable> {
    match state {
        JobState::NotLoaded => Ok(()),
        JobState::Loaded => Err(LegacyDisable::StillRunning),
        JobState::Unknown => Err(LegacyDisable::Unknown),
    }
}

/// The plist's launchd `Label`, needed to query whether the job is loaded.
fn read_label(plist: &Path) -> Option<String> {
    let value = plist::Value::from_file(plist).ok()?;
    value
        .as_dictionary()?
        .get("Label")?
        .as_string()
        .map(str::to_string)
}

/// Query whether launchd has the job loaded. A clean non-zero exit means "not
/// loaded"; a failure to even run `launchctl` is [`JobState::Unknown`] (finding
/// #3) rather than a false "not loaded".
fn job_state(label: &str) -> JobState {
    match Command::new("launchctl").arg("list").arg(label).status() {
        Ok(status) if status.success() => JobState::Loaded,
        Ok(_) => JobState::NotLoaded,
        Err(err) => {
            tracing::warn!("could not run launchctl to inspect {label}: {err}");
            JobState::Unknown
        }
    }
}

/// Ask launchd to unload the legacy job so it releases the port. The deprecated
/// `unload` form works across every launchd vintage without needing the uid;
/// its exit code is unreliable, so the caller re-checks the real state via
/// [`job_state`] rather than trusting it here.
fn unload_job(plist: &Path) {
    match Command::new("launchctl").arg("unload").arg(plist).status() {
        Ok(status) if status.success() => tracing::info!("unloaded legacy LaunchAgent job"),
        Ok(_) => tracing::debug!("launchctl unload returned non-zero"),
        Err(err) => tracing::debug!("launchctl unload failed: {err}"),
    }
}

/// Rename `foo.plist` to `foo.plist.disabled`, preserving the file (reversible,
/// unlike deletion) while making it invisible to launchd's login scan. Returns
/// the new path.
fn rename_disabled(plist: &Path) -> std::io::Result<PathBuf> {
    let mut disabled = plist.as_os_str().to_owned();
    disabled.push(".disabled");
    let disabled = PathBuf::from(disabled);
    std::fs::rename(plist, &disabled)?;
    Ok(disabled)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    const PLIST_XML: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>com.bugtoprompt.test.unique-not-loaded</string>
</dict>
</plist>
"#;

    #[test]
    fn only_a_not_loaded_final_state_is_safe_to_disable() {
        // Findings #1 + #3: a still-loaded job (incl. one that raced our first
        // query) and an undeterminable state must both block; only a positively
        // not-loaded job is safe to rename.
        assert_eq!(outcome_for_final_state(JobState::NotLoaded), Ok(()));
        assert_eq!(
            outcome_for_final_state(JobState::Loaded),
            Err(LegacyDisable::StillRunning)
        );
        assert_eq!(
            outcome_for_final_state(JobState::Unknown),
            Err(LegacyDisable::Unknown)
        );
    }

    #[test]
    fn read_label_extracts_the_launchd_label() {
        let dir = tempfile::tempdir().unwrap();
        let plist = dir.path().join("legacy.plist");
        fs::write(&plist, PLIST_XML).unwrap();
        assert_eq!(
            read_label(&plist).as_deref(),
            Some("com.bugtoprompt.test.unique-not-loaded")
        );
    }

    #[test]
    fn read_label_is_none_without_a_label_key() {
        let dir = tempfile::tempdir().unwrap();
        let plist = dir.path().join("nolabel.plist");
        fs::write(&plist, "<plist><dict/></plist>").unwrap();
        assert!(read_label(&plist).is_none());
    }

    #[test]
    fn rename_disabled_moves_plist_aside() {
        let dir = tempfile::tempdir().unwrap();
        let plist = dir.path().join("com.bugtoprompt.sidecar.plist");
        fs::write(&plist, "<plist/>").unwrap();

        let disabled = rename_disabled(&plist).unwrap();

        assert!(!plist.exists(), "original plist must be gone");
        assert!(disabled.exists(), "disabled sibling must exist");
        assert_eq!(
            disabled.file_name().unwrap().to_str().unwrap(),
            "com.bugtoprompt.sidecar.plist.disabled"
        );
    }

    #[test]
    fn disable_reports_not_present_when_plist_is_absent() {
        let dir = tempfile::tempdir().unwrap();
        let plist = dir.path().join("does-not-exist.plist");
        assert_eq!(
            disable_legacy_launch_agent_at(&plist),
            LegacyDisable::NotPresent
        );
        assert!(!plist.exists());
    }

    #[test]
    fn disable_reports_unknown_when_plist_is_unparseable() {
        // Finding #3: an unreadable plist (no Label) is UNKNOWN, not "absent" —
        // we must not rename it aside and start beside a possibly-running job.
        let dir = tempfile::tempdir().unwrap();
        let plist = dir.path().join("garbage.plist");
        fs::write(&plist, "this is not a plist").unwrap();
        assert_eq!(
            disable_legacy_launch_agent_at(&plist),
            LegacyDisable::Unknown
        );
        assert!(plist.exists(), "unparseable plist must be left in place");
    }

    #[test]
    fn disable_renames_when_the_job_is_not_loaded() {
        // The fixture's Label is a unique name launchd does not know, so
        // job_state is NotLoaded and the full path resolves to Disabled.
        let dir = tempfile::tempdir().unwrap();
        let plist = dir.path().join("legacy.plist");
        fs::write(&plist, PLIST_XML).unwrap();

        assert_eq!(
            disable_legacy_launch_agent_at(&plist),
            LegacyDisable::Disabled
        );
        assert!(!plist.exists(), "plist should have been renamed aside");
        assert!(plist.with_extension("plist.disabled").exists());
    }
}
