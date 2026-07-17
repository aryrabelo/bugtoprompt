//! Local `gh` CLI issue filing (#56) — mirrors `server/github-issue-service.mjs`'s
//! `handleIssue`/`deriveTitle`/`readArtifact`: read the saved artifact, resolve
//! the target repo, and shell out to `gh issue create` via an argument vector
//! (`tokio::process::Command`, never a shell string) so no artifact-derived
//! text can be interpreted as shell syntax, then parse the created issue's
//! number + url from stdout.

use std::path::Path;

use serde_json::Value;

use crate::config::Target;

/// Read a previously-saved artifact.json for `session_id`, or `None` when it
/// doesn't exist or fails to parse. Caller MUST validate `session_id` with
/// `security::is_valid_session_id` first — this only ever joins an
/// already-validated path component, never one straight off the wire.
pub async fn read_artifact(captures_root: &Path, session_id: &str) -> Option<Value> {
    let file = captures_root.join(session_id).join("artifact.json");
    let bytes = tokio::fs::read(file).await.ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Derive an issue title from the saved artifact (transcript -> pageUrl ->
/// session id fallback). Mirrors `deriveTitle`.
///
/// ponytail: clips by `char` count, not UTF-16 code units like Node's
/// `.length` — identical for the ASCII transcript text this ships today,
/// diverges only on exotic non-BMP Unicode; upgrade if that ever matters.
pub fn derive_title(artifact: Option<&Value>, session_id: &str) -> String {
    if let Some(artifact) = artifact {
        if let Some(transcript) = artifact.get("transcript").and_then(Value::as_array) {
            let text = transcript
                .iter()
                .filter_map(|segment| segment.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join(" ");
            let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
            if !text.is_empty() {
                let clipped = if text.chars().count() > 72 {
                    format!("{}...", text.chars().take(69).collect::<String>())
                } else {
                    text
                };
                return format!("BugToPrompt: {clipped}");
            }
        }
        if let Some(page_url) = artifact.get("pageUrl").and_then(Value::as_str) {
            if !page_url.is_empty() {
                return format!("BugToPrompt: {page_url}");
            }
        }
    }
    format!("BugToPrompt capture {session_id}")
}

/// Resolve the target repo: the requested `target_id` when it matches a
/// configured target, else the first configured target — mirrors Node's
/// `(body.targetId && config.byId.get(body.targetId)) || config.targets[0]`
/// (an unknown or absent targetId still falls back to the first target).
pub fn resolve_target<'a>(targets: &'a [Target], target_id: Option<&str>) -> Option<&'a Target> {
    target_id
        .filter(|id| !id.is_empty())
        .and_then(|id| targets.iter().find(|t| t.id == id))
        .or_else(|| targets.first())
}

/// A successfully filed issue.
pub struct CreatedIssue {
    pub number: u64,
    pub url: String,
}

/// Invoke `gh issue create --repo <repo> --title <title> --body-file <file>`
/// through an argument vector (never a shell string, so title/body text can
/// never be interpreted as shell syntax) and parse the number + url from
/// stdout. Any failure — `gh` missing from PATH, unauthenticated, network
/// error, bad repo — surfaces as `Err(detail)` for the caller to report as a
/// clean `502`, never a crash.
pub async fn create_issue(
    repo: &str,
    title: &str,
    body: &str,
    session_id: &str,
) -> Result<CreatedIssue, String> {
    // ponytail: mirrors Node's tmpdir()/bugtoprompt-issue-<sessionId>.md;
    // session_id is already validated (cap_[A-Za-z0-9-]+) by the caller, so
    // it is a safe filename component.
    let body_file = std::env::temp_dir().join(format!("bugtoprompt-issue-{session_id}.md"));
    tokio::fs::write(&body_file, body)
        .await
        .map_err(|err| format!("failed to write issue body: {err}"))?;

    let result = tokio::process::Command::new("gh")
        .arg("issue")
        .arg("create")
        .arg("--repo")
        .arg(repo)
        .arg("--title")
        .arg(title)
        .arg("--body-file")
        .arg(&body_file)
        .output()
        .await;

    let _ = tokio::fs::remove_file(&body_file).await;

    let output = result.map_err(|err| format!("gh issue create failed: {err}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let detail = if stderr.is_empty() {
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        } else {
            stderr
        };
        return Err(format!("gh issue create failed: {detail}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let url = stdout.split_whitespace().last().unwrap_or("").to_string();
    let number = parse_issue_number(&url);
    Ok(CreatedIssue { number, url })
}

/// Extract the numeric issue id from a `.../issues/<n>` URL, mirroring
/// `/\/issues\/(\d+)/`. Any URL without that shape resolves to `0`, matching
/// the Node reference's `match ? Number(match[1]) : 0`.
fn parse_issue_number(url: &str) -> u64 {
    url.rsplit_once("/issues/")
        .and_then(|(_, tail)| {
            let digits: String = tail.chars().take_while(char::is_ascii_digit).collect();
            digits.parse().ok()
        })
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn target(id: &str) -> Target {
        Target {
            id: id.to_string(),
            name: id.to_string(),
            repo: id.to_string(),
            branch: "main".to_string(),
        }
    }

    #[test]
    fn title_prefers_transcript_text() {
        let artifact = json!({
            "transcript": [{ "text": "the button is broken" }, { "text": "on save" }]
        });
        assert_eq!(
            derive_title(Some(&artifact), "cap_abc"),
            "BugToPrompt: the button is broken on save"
        );
    }

    #[test]
    fn title_clips_long_transcript_to_72_chars() {
        let long = "x".repeat(100);
        let artifact = json!({ "transcript": [{ "text": long }] });
        let title = derive_title(Some(&artifact), "cap_abc");
        assert!(title.starts_with("BugToPrompt: "));
        assert!(title.ends_with("..."));
        assert_eq!(title.len(), "BugToPrompt: ".len() + 72);
    }

    #[test]
    fn title_falls_back_to_page_url_then_session_id() {
        let artifact = json!({ "pageUrl": "https://example.com/page" });
        assert_eq!(
            derive_title(Some(&artifact), "cap_abc"),
            "BugToPrompt: https://example.com/page"
        );
        assert_eq!(derive_title(None, "cap_abc"), "BugToPrompt capture cap_abc");
        assert_eq!(
            derive_title(Some(&json!({})), "cap_abc"),
            "BugToPrompt capture cap_abc"
        );
    }

    #[test]
    fn resolve_target_prefers_matching_target_id() {
        let targets = vec![target("a/b"), target("c/d")];
        assert_eq!(resolve_target(&targets, Some("c/d")).unwrap().id, "c/d");
    }

    #[test]
    fn resolve_target_falls_back_to_first_when_unknown_or_absent() {
        let targets = vec![target("a/b")];
        assert_eq!(resolve_target(&targets, Some("nope")).unwrap().id, "a/b");
        assert_eq!(resolve_target(&targets, None).unwrap().id, "a/b");
        assert!(resolve_target(&[], None).is_none());
    }

    #[test]
    fn parse_issue_number_extracts_leading_digits_after_issues_segment() {
        assert_eq!(
            parse_issue_number("https://github.com/acme/web/issues/42"),
            42
        );
        assert_eq!(
            parse_issue_number("https://github.com/acme/web/issues/42\n"),
            42
        );
        assert_eq!(parse_issue_number("not a url"), 0);
    }

    #[tokio::test]
    async fn read_artifact_returns_none_when_missing() {
        let dir = tempfile::TempDir::new().unwrap();
        assert!(read_artifact(dir.path(), "cap_missing").await.is_none());
    }

    #[tokio::test]
    async fn read_artifact_parses_saved_json() {
        let dir = tempfile::TempDir::new().unwrap();
        let session_dir = dir.path().join("cap_abc");
        tokio::fs::create_dir_all(&session_dir).await.unwrap();
        tokio::fs::write(
            session_dir.join("artifact.json"),
            r#"{"pageUrl":"https://example.com"}"#,
        )
        .await
        .unwrap();
        let artifact = read_artifact(dir.path(), "cap_abc").await.unwrap();
        assert_eq!(artifact["pageUrl"], "https://example.com");
    }
}
