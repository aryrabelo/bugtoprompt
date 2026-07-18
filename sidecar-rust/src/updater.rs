//! Auto-update check against GitHub Releases (issue #59, PRD §10 "Auto-update").
//!
//! The tray shell is a plain `tao`/`wry` binary, not a Tauri app, so the Tauri
//! updater *plugin* does not apply. This is the functional equivalent: on
//! startup (and on demand) the tray lists the repo's published releases, selects
//! the highest-semver stable one, compares its `vMAJOR.MINOR.PATCH` tag to the
//! running `CARGO_PKG_VERSION`, and — when a newer one exists — surfaces a tray
//! menu item that opens the release page so the user can download the new `.dmg`.
//!
//! We query the releases *list* (not `/releases/latest`, which is ordered by
//! creation time and hides a backported/out-of-order newer version) and pick the
//! maximum by semver. Draft and pre-release entries, and releases without a
//! usable `https` page URL, are skipped so the tray never advertises an update it
//! cannot open.
//!
//! The network fetch shells out to `curl` (always present on macOS) rather than
//! pulling an HTTP + TLS crate stack: it keeps the binary small (PRD §10 target
//! < 20 MB), matches the crate's existing "shell out to `gh`/`uvx`/`launchctl`"
//! pattern, and keeps the tested surface — parsing and version comparison — pure
//! and offline.

use std::process::Command;

/// A published GitHub release newer than the running build.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReleaseInfo {
    /// The release tag, e.g. `v0.2.0`.
    pub tag: String,
    /// The release page URL to open in a browser for download. Always a
    /// validated `https://` URL (see [`is_valid_release_url`]).
    pub html_url: String,
}

/// Parse a `vMAJOR.MINOR.PATCH` (or shorter `vMAJOR[.MINOR]`) string into a
/// comparable triple. Any pre-release/build suffix (`-rc.1`, `+meta`) is dropped.
/// A tag with MORE than three numeric components (e.g. `1.2.3.4`) is REJECTED
/// (`None`) rather than silently truncated, so a nonconforming tag can never be
/// mis-compared against the documented `vMAJOR.MINOR.PATCH` scheme.
fn parse_version(s: &str) -> Option<(u64, u64, u64)> {
    let core = s.trim().trim_start_matches('v');
    // Drop any pre-release (`-`) or build-metadata (`+`) suffix.
    let core = core.split(['-', '+']).next()?;
    let mut parts = core.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next().unwrap_or("0").parse().ok()?;
    let patch = parts.next().unwrap_or("0").parse().ok()?;
    // A fourth component means the tag does not match vMAJOR.MINOR.PATCH.
    if parts.next().is_some() {
        return None;
    }
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

/// A release page URL is only usable if the tray can open it in a browser, which
/// requires a real `https` URL. Anything else (missing, `http`, empty) is
/// rejected so we never advertise an update that cannot be downloaded.
fn is_valid_release_url(url: &str) -> bool {
    url.starts_with("https://")
}

/// Parse one release object from the GitHub releases array into
/// `(ReleaseInfo, version)`. Returns `None` — i.e. the release is skipped — when
/// it is a draft or pre-release, its tag is missing/nonconforming, or it lacks a
/// usable `https` page URL.
fn parse_release_obj(value: &serde_json::Value) -> Option<(ReleaseInfo, (u64, u64, u64))> {
    let obj = value.as_object()?;
    if obj
        .get("draft")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
    {
        return None;
    }
    if obj
        .get("prerelease")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
    {
        return None;
    }
    let tag = obj.get("tag_name")?.as_str()?.trim().to_string();
    let version = parse_version(&tag)?;
    let html_url = obj.get("html_url")?.as_str()?.trim().to_string();
    if !is_valid_release_url(&html_url) {
        return None;
    }
    Some((ReleaseInfo { tag, html_url }, version))
}

/// Parse a GitHub `/releases` (array) body into the usable stable releases.
/// Malformed JSON or a non-array body yields an empty list.
fn parse_releases(json: &str) -> Vec<(ReleaseInfo, (u64, u64, u64))> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(json) else {
        return Vec::new();
    };
    let Some(array) = value.as_array() else {
        return Vec::new();
    };
    array.iter().filter_map(parse_release_obj).collect()
}

/// The highest-semver stable release in a `/releases` body, regardless of the
/// creation order the API returns them in. `None` when there is no usable
/// release.
pub fn select_highest_release(json: &str) -> Option<ReleaseInfo> {
    parse_releases(json)
        .into_iter()
        .max_by_key(|(_, version)| *version)
        .map(|(info, _)| info)
}

/// Pure detection step: from a `/releases` body, return the highest-semver stable
/// release strictly newer than `current`, or `None`. Factored out from
/// [`check_for_update`] so it is testable offline.
pub fn evaluate_releases(json: &str, current: &str) -> Option<ReleaseInfo> {
    let current = parse_version(current)?;
    parse_releases(json)
        .into_iter()
        .filter(|(_, version)| *version > current)
        .max_by_key(|(_, version)| *version)
        .map(|(info, _)| info)
}

/// The GitHub API endpoint listing a repo's releases (newest page first).
pub fn releases_api_url(repo: &str) -> String {
    format!("https://api.github.com/repos/{repo}/releases?per_page=100")
}

/// Check GitHub for a release newer than `current` (e.g. `env!("CARGO_PKG_VERSION")`).
///
/// `repo` is `owner/name`. Best effort: any curl/network/parse failure yields
/// `None` (never surfaces an error to the user) so a flaky check is invisible.
/// Blocking; call from a background thread.
pub fn check_for_update(repo: &str, current: &str) -> Option<ReleaseInfo> {
    let body = fetch_releases_body(repo)?;
    evaluate_releases(&body, current)
}

/// Fetch the raw `/releases` JSON body via `curl`. `None` on any failure.
fn fetch_releases_body(repo: &str) -> Option<String> {
    let url = releases_api_url(repo);
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

    /// Build one release JSON object with sensible defaults, overridable per test.
    fn release(tag: &str, html_url: &str, draft: bool, prerelease: bool) -> serde_json::Value {
        serde_json::json!({
            "tag_name": tag,
            "html_url": html_url,
            "draft": draft,
            "prerelease": prerelease,
        })
    }

    /// A normal published release with a valid https page URL.
    fn stable(tag: &str) -> serde_json::Value {
        release(
            tag,
            &format!("https://github.com/aryrabelo/bugtoprompt/releases/tag/{tag}"),
            false,
            false,
        )
    }

    fn releases_json(items: Vec<serde_json::Value>) -> String {
        serde_json::Value::Array(items).to_string()
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
    fn rejects_versions_with_more_than_three_components() {
        // Finding #8: extra components must be rejected, not silently truncated.
        assert_eq!(parse_version("1.2.3.4"), None);
        assert_eq!(parse_version("v1.2.3.0"), None);
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
        assert!(!is_newer("0.1.0", "garbage"));
        assert!(!is_newer("garbage", "0.2.0"));
    }

    #[test]
    fn is_valid_release_url_requires_https() {
        assert!(is_valid_release_url(
            "https://github.com/x/y/releases/tag/v1"
        ));
        assert!(!is_valid_release_url("http://insecure"));
        assert!(!is_valid_release_url(""));
    }

    #[test]
    fn evaluate_detects_a_newer_release() {
        // Acceptance (#59): a served response advertising a newer tag is detected.
        let json = releases_json(vec![stable("v0.2.0"), stable("v0.1.0")]);
        assert_eq!(
            evaluate_releases(&json, "0.1.0"),
            Some(ReleaseInfo {
                tag: "v0.2.0".to_string(),
                html_url: "https://github.com/aryrabelo/bugtoprompt/releases/tag/v0.2.0"
                    .to_string(),
            })
        );
    }

    #[test]
    fn evaluate_picks_highest_semver_not_creation_order() {
        // Finding #5: /releases is creation-ordered. A backport released AFTER a
        // higher version puts the higher version later in the array; we must
        // still pick the highest semver.
        let json = releases_json(vec![
            stable("v0.2.1"), // newest by creation (a backport)
            stable("v0.3.0"), // higher semver, released earlier
            stable("v0.2.0"),
        ]);
        assert_eq!(evaluate_releases(&json, "0.1.0").unwrap().tag, "v0.3.0");
        assert_eq!(select_highest_release(&json).unwrap().tag, "v0.3.0");
    }

    #[test]
    fn evaluate_skips_drafts_and_prereleases() {
        let json = releases_json(vec![
            release("v0.9.0", "https://x/y/releases/tag/v0.9.0", true, false), // draft
            release("v0.8.0", "https://x/y/releases/tag/v0.8.0", false, true), // prerelease
            stable("v0.2.0"),
        ]);
        assert_eq!(evaluate_releases(&json, "0.1.0").unwrap().tag, "v0.2.0");
    }

    #[test]
    fn evaluate_skips_releases_without_a_usable_url() {
        // Finding #4: a higher release with a missing/non-https URL must not be
        // advertised; fall back to the highest one the tray can actually open.
        let json = releases_json(vec![
            release("v0.5.0", "http://insecure/tag/v0.5.0", false, false),
            serde_json::json!({ "tag_name": "v0.4.0", "draft": false, "prerelease": false }),
            stable("v0.2.0"),
        ]);
        assert_eq!(evaluate_releases(&json, "0.1.0").unwrap().tag, "v0.2.0");
    }

    #[test]
    fn evaluate_ignores_same_or_older_releases() {
        assert!(evaluate_releases(&releases_json(vec![stable("v0.1.0")]), "0.1.0").is_none());
        assert!(evaluate_releases(&releases_json(vec![stable("v0.0.9")]), "0.1.0").is_none());
    }

    #[test]
    fn evaluate_handles_empty_and_malformed_bodies() {
        assert!(evaluate_releases("[]", "0.1.0").is_none());
        assert!(evaluate_releases("not json", "0.1.0").is_none());
        // A single object (the old /releases/latest shape) is not an array.
        assert!(evaluate_releases(r#"{"tag_name":"v9.9.9"}"#, "0.1.0").is_none());
    }

    #[test]
    fn releases_api_url_lists_the_repo_releases() {
        assert_eq!(
            releases_api_url("aryrabelo/bugtoprompt"),
            "https://api.github.com/repos/aryrabelo/bugtoprompt/releases?per_page=100"
        );
    }
}
