//! Retire the legacy Node LaunchAgent (issue #59).
//!
//! The old `bugtoprompt-server` shipped as a hand-installed LaunchAgent plist
//! (`~/Library/LaunchAgents/com.bugtoprompt.sidecar.plist`) that launchd starts
//! on login and binds to port 4127. The new tray app owns that port itself, so
//! if both were live they would double-bind it. On startup the tray calls
//! [`disable_legacy_launch_agent`] BEFORE it spawns its own server: it stops the
//! running legacy job (releasing the port) and, only once it has confirmed the
//! job is actually gone, renames the plist so launchd never reloads it on the
//! next login. If the job could NOT be stopped, it reports [`LegacyDisable::StillRunning`]
//! and leaves the plist in place so the caller can surface a clear error instead
//! of racing into a doomed bind. The one-time env import lives separately in
//! [`crate::migrate`]; this module only tears the old daemon down.

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::migrate::default_launch_agent_path;

/// Outcome of attempting to retire the legacy LaunchAgent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LegacyDisable {
    /// No legacy plist was found — nothing to do.
    NotPresent,
    /// The job was stopped (or never loaded) and the plist renamed aside.
    Disabled,
    /// The job is still loaded after the unload attempt: the port is NOT free,
    /// so the plist was left in place. The caller must not bind the port.
    StillRunning,
    /// The job was stopped but the plist could not be renamed (fs error). The
    /// port is free for this session; launchd may reload it at the next login.
    RenameFailed,
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
/// running job, verifies it actually stopped, and only then renames the plist.
pub fn disable_legacy_launch_agent_at(plist: &Path) -> LegacyDisable {
    if !plist.exists() {
        return LegacyDisable::NotPresent;
    }
    let label = read_label(plist);
    let loaded_before = label.as_deref().map(is_job_loaded).unwrap_or(false);
    if loaded_before {
        unload_job(plist);
    }
    let loaded_after = label.as_deref().map(is_job_loaded).unwrap_or(false);
    if !stop_succeeded(loaded_before, loaded_after) {
        tracing::error!(
            "legacy LaunchAgent {} is still running after unload; leaving its plist in place so the port is not double-bound",
            plist.display()
        );
        return LegacyDisable::StillRunning;
    }
    match rename_disabled(plist) {
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
    }
}

/// Whether the legacy job is now stopped: it either was never loaded, or the
/// unload attempt actually cleared it. A job that was loaded and is STILL loaded
/// means the port was not released, so we must not proceed.
fn stop_succeeded(loaded_before: bool, loaded_after: bool) -> bool {
    !(loaded_before && loaded_after)
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

/// Whether launchd currently has the job loaded (`launchctl list <label>` exits 0).
fn is_job_loaded(label: &str) -> bool {
    Command::new("launchctl")
        .arg("list")
        .arg(label)
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

/// Ask launchd to unload the legacy job so it releases the port. The deprecated
/// `unload` form works across every launchd vintage without needing the uid;
/// its exit code is unreliable (non-zero when not loaded), so the caller
/// confirms the real state via [`is_job_loaded`] rather than trusting it here.
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
    fn stop_succeeded_truth_table() {
        // Finding #2: only "was loaded AND still loaded" is a failure.
        assert!(stop_succeeded(false, false)); // never loaded
        assert!(stop_succeeded(true, false)); // unloaded successfully
        assert!(!stop_succeeded(true, true)); // could not stop -> not safe
        assert!(stop_succeeded(false, true)); // wasn't ours to begin with
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
    fn disable_renames_when_the_job_is_not_loaded() {
        // The fixture's Label is a unique name launchd does not know, so
        // is_job_loaded is false and the full path resolves to Disabled.
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
