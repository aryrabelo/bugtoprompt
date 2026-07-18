//! Auto-update check against GitHub Releases (issue #59, PRD §10 "Auto-update").
//!
//! The tray shell is a plain `tao`/`wry` binary, not a Tauri app, so the Tauri
//! updater *plugin* does not apply. This is the functional equivalent: on
//! startup (and on demand) the tray asks GitHub for the latest published
//! release, compares its `vMAJOR.MINOR.PATCH` tag to the running
//! `CARGO_PKG_VERSION`, and \u2014 when a newer one exists \u2014 surfaces a tray menu
//! item that opens the release page so the user can download the new `.dmg`.
//!
//! The network fetch shells out to `curl` (always present on macOS) rather than
//! pulling an HTTP + TLS crate stack: it keeps the binary small (PRD §10 target
//! < 20 MB), matches the crate's existing "shell out to `gh`/`uvx`/`launchctl`"
//! pattern, and keeps the tested surface \u2014 parsing and version comparison \u2014
//! pure and offline.

use std::process::Command;

/// A published GitHub release newer than the running build.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReleaseInfo {
    /// The release tag, e.g. `v0.2.0`.
    pub tag: String,
    /// The release page URL to open in a browser for download.
    pub html_url: String,
}

/// Parse a `vMAJOR.MINOR.PATCH` (or bare `MAJOR.MINOR.PATCH`) string into a
/// comparable triple. Any pre-release/build suffix (`-rc.1`, `+meta`) is
/// dropped: for "is there a newer stable release" this coarse compare is
/// sufficient and keeps the updater dependency-free. Missing minor/patch
/// default to 0 (`v1` == `1.0.0`).
fn parse_version(s: &str) -> Option<(u64, u64, u64)> {
    let core = s.trim().trim_start_matches('v');
    // Drop any pre-release (`-`) or build-metadata (`+`) suffix.
    let core = core.split(['-', '+']).next()?;
    let mut parts = core.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next().unwrap_or("0").parse().ok()?;
    let patch = parts.next().unwrap_or("0").parse().ok()?;
    Some((major, minor, patch))
}

/// Whether `candidate` names a strictly newer version than `current`. Returns
/// `false` if either side fails to parse (never offer a downgrade on garbage).
pub fn is_newer(current: &str, candidate: &str) -> bool {
    match (parse_version(current), parse_version(candidate)) {
        (Some(cur), Some(cand)) => cand > cur,
        _ => false,
    }
}

/// Extract `{ tag, html_url }` from a GitHub `releases/latest` JSON body.
/// Returns `None` for malformed JSON or a body missing `tag_name`.
pub fn parse_latest_release(json: &str) -> Option<ReleaseInfo> {
    let value: serde_json::Value = serde_json::from_str(json).ok()?;
    let tag = value.get("tag_name")?.as_str()?.trim().to_string();
    if tag.is_empty() {
        return None;
    }
    let html_url = value
        .get("html_url")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
        .unwrap_or_default();
    Some(ReleaseInfo { tag, html_url })
}

/// Pure detection step: parse a `releases/latest` body and return the release
/// only when its tag is strictly newer than `current`. This is the exact logic
/// [`check_for_update`] applies to the live response, factored out so it is
/// testable offline (the acceptance test for "detects a newer release").
pub fn evaluate_latest_release(json: &str, current: &str) -> Option<ReleaseInfo> {
    let release = parse_latest_release(json)?;
    is_newer(current, &release.tag).then_some(release)
}

/// The GitHub API endpoint for a repo's latest published release.
pub fn latest_release_api_url(repo: &str) -> String {
    format!("https://api.github.com/repos/{repo}/releases/latest")
}

/// Check GitHub for a release newer than `current` (e.g. `env!("CARGO_PKG_VERSION")`).
///
/// `repo` is `owner/name`. Best effort: any curl/network/parse failure yields
/// `None` (never surfaces an error to the user) so a flaky check is invisible.
/// Blocking; call from a background thread.
pub fn check_for_update(repo: &str, current: &str) -> Option<ReleaseInfo> {
    let body = fetch_latest_release_body(repo)?;
    evaluate_latest_release(&body, current)
}

/// Fetch the raw `releases/latest` JSON body via `curl`. `None` on any failure.
fn fetch_latest_release_body(repo: &str) -> Option<String> {
    let url = latest_release_api_url(repo);
    let output = Command::new("curl")
        .args([
            "--silent",
            "--show-error",
            "--fail",
            "--location",
            // GitHub requires a User-Agent; bound the request so a hung
            // network never wedges the background thread.
            "--max-time",
            "10",
            "--user-agent",
            concat!("bugtoprompt-sidecar/", env!("CARGO_PKG_VERSION")),
            "--header",
            "Accept: application/vnd.github+json",
            &url,
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        tracing::debug!("update check: curl exited {:?}", output.status.code());
        return None;
    }
    String::from_utf8(output.stdout).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn release_json(tag: &str) -> String {
        format!(
            r#"{{"tag_name":"{tag}","html_url":"https://github.com/aryrabelo/bugtoprompt/releases/tag/{tag}","name":"{tag}"}}"#
        )
    }

    #[test]
    fn parses_semver_with_and_without_v_prefix() {
        assert_eq!(parse_version("v1.2.3"), Some((1, 2, 3)));
        assert_eq!(parse_version("1.2.3"), Some((1, 2, 3)));
        assert_eq!(parse_version(" 0.1.0 "), Some((0, 1, 0)));
        assert_eq!(parse_version("v2"), Some((2, 0, 0)));
        assert_eq!(parse_version("v1.4"), Some((1, 4, 0)));
    }

    #[test]
    fn parses_version_dropping_prerelease_and_build_metadata() {
        assert_eq!(parse_version("v1.2.3-rc.1"), Some((1, 2, 3)));
        assert_eq!(parse_version("1.2.3+build.7"), Some((1, 2, 3)));
    }

    #[test]
    fn rejects_unparseable_versions() {
        assert_eq!(parse_version("latest"), None);
        assert_eq!(parse_version(""), None);
        assert_eq!(parse_version("v.x.y"), None);
    }

    #[test]
    fn is_newer_compares_release_ordering() {
        assert!(is_newer("0.1.0", "0.2.0"));
        assert!(is_newer("v0.1.0", "v0.1.1"));
        assert!(is_newer("1.0.0", "2.0.0"));
        assert!(!is_newer("0.2.0", "0.1.0"));
        assert!(!is_newer("0.1.0", "0.1.0"));
        // Unparseable candidate must never offer an "update".
        assert!(!is_newer("0.1.0", "garbage"));
        assert!(!is_newer("garbage", "0.2.0"));
    }

    #[test]
    fn parse_latest_release_extracts_tag_and_url() {
        let info = parse_latest_release(&release_json("v0.3.0")).expect("parses");
        assert_eq!(info.tag, "v0.3.0");
        assert_eq!(
            info.html_url,
            "https://github.com/aryrabelo/bugtoprompt/releases/tag/v0.3.0"
        );
    }

    #[test]
    fn parse_latest_release_rejects_garbage_and_missing_tag() {
        assert!(parse_latest_release("not json").is_none());
        assert!(parse_latest_release(r#"{"name":"no tag here"}"#).is_none());
        assert!(parse_latest_release(r#"{"tag_name":""}"#).is_none());
    }

    #[test]
    fn evaluate_detects_a_newer_release() {
        // Acceptance (#59): a staged/served response advertising a newer tag is
        // detected as an available update.
        let current = "0.1.0";
        let detected = evaluate_latest_release(&release_json("v0.2.0"), current);
        assert_eq!(
            detected,
            Some(ReleaseInfo {
                tag: "v0.2.0".to_string(),
                html_url: "https://github.com/aryrabelo/bugtoprompt/releases/tag/v0.2.0"
                    .to_string(),
            })
        );
    }

    #[test]
    fn evaluate_ignores_same_or_older_releases() {
        assert!(evaluate_latest_release(&release_json("v0.1.0"), "0.1.0").is_none());
        assert!(evaluate_latest_release(&release_json("v0.0.9"), "0.1.0").is_none());
    }

    #[test]
    fn latest_release_api_url_targets_the_repo() {
        assert_eq!(
            latest_release_api_url("aryrabelo/bugtoprompt"),
            "https://api.github.com/repos/aryrabelo/bugtoprompt/releases/latest"
        );
    }
}
