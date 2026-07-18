//! Retire the legacy Node LaunchAgent (issue #59).
//!
//! The old `bugtoprompt-server` shipped as a hand-installed LaunchAgent plist
//! (`~/Library/LaunchAgents/com.bugtoprompt.sidecar.plist`) that launchd starts
//! on login and binds to port 4127. The new tray app owns that port itself, so
//! if both were live they would double-bind it. On startup the tray calls
//! [`disable_legacy_launch_agent`] BEFORE it spawns its own server: it stops the
//! running legacy job (releasing 4127) and renames the plist so launchd never
//! reloads it on the next login. The one-time env import lives separately in
//! [`crate::migrate`]; this module only tears the old daemon down.

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::migrate::default_launch_agent_path;

/// Stop and permanently disable the legacy LaunchAgent at the default path.
/// Returns `true` when a plist was present and has now been disabled. Idempotent
/// and best effort: once the plist is renamed, later calls are no-ops, and any
/// failure is logged and swallowed so it never blocks startup.
pub fn disable_legacy_launch_agent() -> bool {
    let Some(plist) = default_launch_agent_path() else {
        return false;
    };
    disable_legacy_launch_agent_at(&plist)
}

/// [`disable_legacy_launch_agent`] against an explicit plist path. Stops the
/// running job (so it releases the port immediately) then renames the plist.
pub fn disable_legacy_launch_agent_at(plist: &Path) -> bool {
    if !plist.exists() {
        return false;
    }
    stop_legacy_job(plist);
    match rename_disabled(plist) {
        Ok(disabled) => {
            tracing::info!(
                "disabled legacy LaunchAgent: {} -> {}",
                plist.display(),
                disabled.display()
            );
            true
        }
        Err(err) => {
            tracing::warn!(
                "could not disable legacy LaunchAgent {}: {err}",
                plist.display()
            );
            false
        }
    }
}

/// Ask launchd to unload the running legacy job so it releases port 4127 now.
/// `launchctl unload <path>` is deprecated but works across every macOS launchd
/// vintage and needs neither the numeric uid nor the plist Label. Best effort:
/// a job that is not loaded just makes launchctl exit non-zero, which we ignore.
fn stop_legacy_job(plist: &Path) {
    match Command::new("launchctl").arg("unload").arg(plist).status() {
        Ok(status) if status.success() => {
            tracing::info!("unloaded legacy LaunchAgent job");
        }
        Ok(_) => tracing::debug!("legacy LaunchAgent was not loaded (nothing to unload)"),
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
        assert_eq!(fs::read_to_string(&disabled).unwrap(), "<plist/>");
    }

    #[test]
    fn disable_is_a_no_op_when_plist_is_absent() {
        let dir = tempfile::tempdir().unwrap();
        let plist = dir.path().join("does-not-exist.plist");
        // No file present: returns false without touching launchctl or the fs.
        assert!(!disable_legacy_launch_agent_at(&plist));
        assert!(!plist.exists());
    }
}
