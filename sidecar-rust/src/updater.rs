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

/// A parsed release paired with its comparable `(major, minor, patch)` version.
type VersionedRelease = (ReleaseInfo, (u64, u64, u64));

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

/// A release page URL is only usable if the tray can open it in a browser, so it
/// must be a real `https` URL with a non-empty host. Parsed with `url::Url`
/// rather than a prefix check, which would wrongly accept `"https://"` (scheme
/// only, no host) — see finding #4.
fn is_valid_release_url(url: &str) -> bool {
    match url::Url::parse(url) {
        Ok(parsed) => {
            parsed.scheme() == "https" && parsed.host_str().is_some_and(|h| !h.is_empty())
        }
        Err(_) => false,
    }
}

/// Parse one release object from the GitHub releases array into
/// `(ReleaseInfo, version)`. Returns `None` — i.e. the release is skipped — when
/// it is a draft or pre-release, its tag is missing/nonconforming, or it lacks a
/// usable `https` page URL.
fn parse_release_obj(value: &serde_json::Value) -> Option<VersionedRelease> {
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

/// Releases requested per page. GitHub returns releases newest-first.
const PER_PAGE: usize = 100;

/// Safety bound only. The real terminator is the first short (not-full) page —
/// see [`is_last_page`] — so every page of a normal repo is scanned. This cap
/// merely prevents an unbounded loop if the API kept returning full pages
/// forever; 100 pages = 10k releases, far beyond any real repo.
const MAX_PAGES: u32 = 100;

/// A page with fewer than [`PER_PAGE`] releases is the last one.
fn is_last_page(raw_count: usize) -> bool {
    raw_count < PER_PAGE
}

/// Parse a GitHub `/releases` page into `(raw_count, usable_releases)`.
/// `raw_count` is the number of release objects the API returned — used to
/// detect the last page — and must count ALL entries, not just the usable ones,
/// so pagination does not stop early on a page that is entirely drafts/
/// pre-releases. Malformed JSON or a non-array body yields `(0, empty)`.
fn parse_releases_page(json: &str) -> (usize, Vec<VersionedRelease>) {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(json) else {
        return (0, Vec::new());
    };
    let Some(array) = value.as_array() else {
        return (0, Vec::new());
    };
    (
        array.len(),
        array.iter().filter_map(parse_release_obj).collect(),
    )
}

/// Parse a single `/releases` body into its usable stable releases.
fn parse_releases(json: &str) -> Vec<VersionedRelease> {
    parse_releases_page(json).1
}

/// The highest-semver release strictly newer than `current` among `candidates`
/// (which may be accumulated across several pages).
fn highest_newer(
    candidates: Vec<VersionedRelease>,
    current: (u64, u64, u64),
) -> Option<ReleaseInfo> {
    candidates
        .into_iter()
        .filter(|(_, version)| *version > current)
        .max_by_key(|(_, version)| *version)
        .map(|(info, _)| info)
}

/// The highest-semver stable release in a single `/releases` body, regardless of
/// creation order. `None` when there is no usable release.
pub fn select_highest_release(json: &str) -> Option<ReleaseInfo> {
    parse_releases(json)
        .into_iter()
        .max_by_key(|(_, version)| *version)
        .map(|(info, _)| info)
}

/// Pure detection step for a SINGLE page: the highest-semver stable release
/// strictly newer than `current`, or `None`. Kept for offline tests and simple
/// callers; the live check ([`check_for_update`]) scans every page.
pub fn evaluate_releases(json: &str, current: &str) -> Option<ReleaseInfo> {
    let current = parse_version(current)?;
    highest_newer(parse_releases(json), current)
}

/// The GitHub API endpoint for one page of a repo's releases (newest first).
pub fn releases_api_url(repo: &str, page: u32) -> String {
    format!("https://api.github.com/repos/{repo}/releases?per_page={PER_PAGE}&page={page}")
}

/// Check GitHub for a release newer than `current` (e.g. `env!("CARGO_PKG_VERSION")`).
///
/// `repo` is `owner/name`. Scans successive release pages and returns the
/// highest-semver stable release newer than `current` across ALL of them, so a
/// backported/out-of-order newer version on a later page is not missed
/// (finding #5). Best effort: any curl/network/parse failure ends the scan and
/// yields the best found so far (or `None`). Blocking; call from a background
/// thread.
pub fn check_for_update(repo: &str, current: &str) -> Option<ReleaseInfo> {
    let current = parse_version(current)?;
    let mut best: Option<VersionedRelease> = None;
    for page in 1..=MAX_PAGES {
        let Some(body) = fetch_releases_body(repo, page) else {
            break;
        };
        let (raw_count, usable) = parse_releases_page(&body);
        for (info, version) in usable {
            if version > current && best.as_ref().is_none_or(|(_, b)| version > *b) {
                best = Some((info, version));
            }
        }
        // Stop at the first not-full page — the natural end of the release list.
        // MAX_PAGES is only a safety net if the API never returns a short page.
        if is_last_page(raw_count) {
            break;
        }
    }
    best.map(|(info, _)| info)
}

/// Fetch one `/releases` page body via `curl`. `None` on any failure.
fn fetch_releases_body(repo: &str, page: u32) -> Option<String> {
    let url = releases_api_url(repo, page);
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
    fn is_valid_release_url_requires_https_scheme_and_host() {
        assert!(is_valid_release_url(
            "https://github.com/x/y/releases/tag/v1"
        ));
        assert!(!is_valid_release_url("http://insecure.example"));
        // Finding #4: scheme-only, no host must be rejected.
        assert!(!is_valid_release_url("https://"));
        assert!(!is_valid_release_url(""));
        assert!(!is_valid_release_url("ftp://github.com/x"));
        assert!(!is_valid_release_url("not a url"));
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
            release("v0.6.0", "https://", false, false), // https, but no host
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
    fn parse_releases_page_reports_raw_count_including_filtered() {
        // Finding #5: raw_count counts ALL entries so pagination does not stop
        // early on a page that is entirely drafts/pre-releases.
        let json = releases_json(vec![
            release("v0.8.0", "https://github.com/x/y/tag/v0.8.0", false, true), // prerelease
            stable("v0.2.0"),
        ]);
        let (raw, usable) = parse_releases_page(&json);
        assert_eq!(raw, 2);
        assert_eq!(usable.len(), 1);
        assert_eq!(usable[0].0.tag, "v0.2.0");
    }

    #[test]
    fn highest_newer_selects_across_merged_pages() {
        // Finding #5: the highest-semver newer release wins no matter which page
        // it came from.
        let mut merged = parse_releases(&releases_json(vec![stable("v0.2.0"), stable("v0.2.1")]));
        merged.extend(parse_releases(&releases_json(vec![
            stable("v0.4.0"),
            stable("v0.3.0"),
        ])));
        assert_eq!(highest_newer(merged, (0, 1, 0)).unwrap().tag, "v0.4.0");
    }

    #[test]
    fn is_last_page_detects_a_not_full_page() {
        // Finding: a full page means "keep scanning"; only a short page ends it,
        // so a repo with >MAX_PAGES*PER_PAGE releases is not cut off by the cap.
        assert!(is_last_page(0));
        assert!(is_last_page(99));
        assert!(!is_last_page(100));
    }

    #[test]
    fn releases_api_url_lists_a_page_of_repo_releases() {
        assert_eq!(
            releases_api_url("aryrabelo/bugtoprompt", 2),
            "https://api.github.com/repos/aryrabelo/bugtoprompt/releases?per_page=100&page=2"
        );
    }
}
