//! Pure logic for the Settings webview (issue #58): the IPC message contract
//! with `settings.html`, and the mapping between the webview's JSON and the
//! persisted [`PersistedConfig`]. Kept free of any `wry`/`tao` types so it is
//! unit-testable headlessly — the GUI shell in `settings_window.rs` is the only
//! part that needs a display (mirrors the #57 tray model: logic tested, GUI
//! manual-smoke only).

use serde::{Deserialize, Serialize};

use sidecar_rust::config::{PersistedConfig, RawRepoEntry};

/// State pushed to the webview (`window.__btp.onState`). Snake-case keys match
/// what `settings.html` reads.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct UiState {
    pub running: bool,
    pub host: String,
    pub port: u16,
    pub uvx_status: String,
    pub tier: String,
    pub email: String,
    pub transcription_engine: String,
    pub github_mode: String,
    pub issue_mode: bool,
    pub repos: Vec<String>,
    pub allowed_origins: Vec<String>,
}

/// The subset of settings the webview edits. Camel-case matches the JSON the
/// `save` message carries under `config`. No `serde(default)`: every field must
/// be present, so a partial/older payload fails to parse and is rejected rather
/// than silently clearing the omitted settings (finding #5).
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SavePayload {
    pub tier: String,
    pub email: String,
    pub transcription_engine: String,
    pub github_mode: String,
    pub repos: Vec<String>,
    pub allowed_origins: Vec<String>,
}

/// Messages the webview sends to Rust via `window.ipc.postMessage`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Ipc {
    /// Window loaded — Rust replies by pushing current state.
    Ready,
    /// Persist the edited settings and restart the server.
    Save { config: SavePayload },
    /// Re-probe `uvx` availability.
    ProbeUvx,
    /// Install `uv` (which provides `uvx`).
    InstallUvx,
    /// Quit the whole app.
    Quit,
}

/// Parse an IPC message string; `None` when it is not a recognized message.
pub fn parse_ipc(raw: &str) -> Option<Ipc> {
    serde_json::from_str(raw).ok()
}

fn repo_to_string(entry: &RawRepoEntry) -> String {
    match entry {
        RawRepoEntry::Str(s) => s.clone(),
        RawRepoEntry::Obj { repo, branch, .. } => match branch {
            Some(b) if !b.is_empty() => format!("{repo}#{b}"),
            _ => repo.clone(),
        },
    }
}

/// Build the state to render, from the persisted config plus live runtime info.
pub fn build_ui_state(
    cfg: &PersistedConfig,
    running: bool,
    host: &str,
    port: u16,
    uvx_status: &str,
) -> UiState {
    UiState {
        running,
        host: host.to_string(),
        port,
        uvx_status: uvx_status.to_string(),
        tier: cfg.tier.clone().unwrap_or_else(|| "lite".to_string()),
        email: cfg.email.clone().unwrap_or_default(),
        transcription_engine: cfg
            .transcription_engine
            .clone()
            .unwrap_or_else(|| "local".to_string()),
        github_mode: cfg
            .github_mode
            .clone()
            .unwrap_or_else(|| "local".to_string()),
        issue_mode: cfg.issue_mode.unwrap_or(false),
        repos: cfg
            .repos
            .as_deref()
            .unwrap_or_default()
            .iter()
            .map(repo_to_string)
            .collect(),
        allowed_origins: cfg.allowed_origins.clone().unwrap_or_default(),
    }
}

/// JSON for `build_ui_state`, ready to hand to `window.__btp.onState(...)`.
pub fn state_json(
    cfg: &PersistedConfig,
    running: bool,
    host: &str,
    port: u16,
    uvx_status: &str,
) -> String {
    serde_json::to_string(&build_ui_state(cfg, running, host, port, uvx_status))
        .unwrap_or_else(|_| "{}".to_string())
}

/// Split `owner/repo#branch` into `(repo, Option<branch>)`.
fn split_repo_spec(spec: &str) -> (String, Option<String>) {
    let mut parts = spec.splitn(2, '#');
    let repo = parts.next().unwrap_or("").trim().to_string();
    let branch = parts
        .next()
        .map(str::trim)
        .filter(|b| !b.is_empty())
        .map(str::to_string);
    (repo, branch)
}

/// The `owner/repo` key of an entry, ignoring any branch.
fn repo_key(entry: &RawRepoEntry) -> String {
    match entry {
        RawRepoEntry::Str(s) => s.split('#').next().unwrap_or("").trim().to_string(),
        RawRepoEntry::Obj { repo, .. } => repo.trim().to_string(),
    }
}

/// TOML cannot serialize an array mixing bare strings and tables. If any
/// structured entry survived the merge, promote every entry to the table form
/// so the array is homogeneous (and round-trips).
fn homogenize_repos(entries: Vec<RawRepoEntry>) -> Vec<RawRepoEntry> {
    if !entries
        .iter()
        .any(|e| matches!(e, RawRepoEntry::Obj { .. }))
    {
        return entries;
    }
    entries
        .into_iter()
        .map(|e| match e {
            RawRepoEntry::Str(s) => {
                let (repo, branch) = split_repo_spec(&s);
                RawRepoEntry::Obj {
                    id: None,
                    name: None,
                    repo,
                    branch,
                }
            }
            obj => obj,
        })
        .collect()
}

/// Merge a webview save payload into the current persisted config. Empty
/// strings/lists clear a field (become `None`); `issue_mode`, `project_id`,
/// `token`, `host`, `port` and other non-UI fields are preserved as-is.
/// Repo rows that match an existing structured entry keep their `id`/`name`
/// (finding #6); repo/origin rows are de-duplicated preserving first-seen order
/// (finding #13).
pub fn apply_save(mut cfg: PersistedConfig, payload: SavePayload) -> PersistedConfig {
    let opt = |s: String| {
        let t = s.trim().to_string();
        if t.is_empty() { None } else { Some(t) }
    };
    cfg.tier = opt(payload.tier);
    cfg.email = opt(payload.email);
    cfg.transcription_engine = opt(payload.transcription_engine);
    cfg.github_mode = opt(payload.github_mode);

    let current = cfg.repos.take().unwrap_or_default();
    let mut merged: Vec<RawRepoEntry> = Vec::new();
    let mut seen_repos = std::collections::HashSet::new();
    for spec in payload.repos {
        let (repo, branch) = split_repo_spec(&spec);
        if repo.is_empty() || !seen_repos.insert(repo.clone()) {
            continue;
        }
        match current.iter().find(|e| repo_key(e) == repo) {
            Some(RawRepoEntry::Obj { id, name, .. }) => merged.push(RawRepoEntry::Obj {
                id: id.clone(),
                name: name.clone(),
                repo,
                branch,
            }),
            _ => merged.push(RawRepoEntry::Str(spec.trim().to_string())),
        }
    }
    let merged = homogenize_repos(merged);
    cfg.repos = if merged.is_empty() {
        None
    } else {
        Some(merged)
    };

    let mut seen_origins = std::collections::HashSet::new();
    let origins: Vec<String> = payload
        .allowed_origins
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .filter(|s| seen_origins.insert(s.clone()))
        .collect();
    cfg.allowed_origins = if origins.is_empty() {
        None
    } else {
        Some(origins)
    };

    cfg
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_ready_and_lifecycle_messages() {
        assert_eq!(parse_ipc(r#"{"type":"ready"}"#), Some(Ipc::Ready));
        assert_eq!(parse_ipc(r#"{"type":"probeUvx"}"#), Some(Ipc::ProbeUvx));
        assert_eq!(parse_ipc(r#"{"type":"installUvx"}"#), Some(Ipc::InstallUvx));
        assert_eq!(parse_ipc(r#"{"type":"quit"}"#), Some(Ipc::Quit));
        assert_eq!(parse_ipc("not json"), None);
        assert_eq!(parse_ipc(r#"{"type":"bogus"}"#), None);
    }

    #[test]
    fn parses_save_with_camel_case_config() {
        let msg = parse_ipc(
            r#"{"type":"save","config":{
                "tier":"pro","email":"a@b.com","transcriptionEngine":"local",
                "githubMode":"local",
                "repos":["acme/web","acme/api#dev"],
                "allowedOrigins":["https://x.example"]
            }}"#,
        )
        .expect("save parses");
        match msg {
            Ipc::Save { config } => {
                assert_eq!(config.tier, "pro");
                assert_eq!(config.transcription_engine, "local");
                assert_eq!(config.repos, vec!["acme/web", "acme/api#dev"]);
                assert_eq!(config.allowed_origins, vec!["https://x.example"]);
            }
            other => panic!("expected Save, got {other:?}"),
        }
    }

    #[test]
    fn apply_save_merges_and_clears_empty_fields() {
        let cur = PersistedConfig {
            issue_mode: Some(true),
            token: Some("keep-me".to_string()),
            port: Some(4127),
            ..Default::default()
        };
        let payload = SavePayload {
            tier: "pro".to_string(),
            email: "  ".to_string(), // whitespace → cleared
            transcription_engine: "local".to_string(),
            github_mode: "local".to_string(),
            repos: vec!["acme/web".to_string(), "  ".to_string()],
            allowed_origins: vec!["https://gerarposts.com.br".to_string()],
        };
        let next = apply_save(cur, payload);

        // preserved non-UI fields
        assert_eq!(next.issue_mode, Some(true));
        assert_eq!(next.token.as_deref(), Some("keep-me"));
        assert_eq!(next.port, Some(4127));
        // updated / cleared
        assert_eq!(next.tier.as_deref(), Some("pro"));
        assert_eq!(next.email, None);
        assert_eq!(
            next.repos,
            Some(vec![RawRepoEntry::Str("acme/web".to_string())])
        );
        assert_eq!(
            next.allowed_origins,
            Some(vec!["https://gerarposts.com.br".to_string()])
        );
    }

    #[test]
    fn state_json_has_ui_keys_and_stringified_repos() {
        let cfg = PersistedConfig {
            repos: Some(vec![
                RawRepoEntry::Str("acme/web".to_string()),
                RawRepoEntry::Obj {
                    id: None,
                    name: None,
                    repo: "acme/api".to_string(),
                    branch: Some("dev".to_string()),
                },
            ]),
            allowed_origins: Some(vec!["https://x.example".to_string()]),
            ..Default::default()
        };
        let json = state_json(&cfg, true, "127.0.0.1", 4127, "ready");
        assert!(json.contains("\"running\":true"));
        assert!(json.contains("\"uvx_status\":\"ready\""));
        assert!(json.contains("\"tier\":\"lite\"")); // default when unset
        assert!(json.contains("\"transcription_engine\":\"local\""));
        assert!(json.contains("acme/api#dev"), "json:{json}");
        assert!(json.contains("https://x.example"));
    }
    #[test]
    fn rejects_partial_save_payload() {
        // Missing githubMode/repos/allowedOrigins → must not parse (finding #5)
        // so omitted settings are never silently cleared.
        assert_eq!(
            parse_ipc(
                r#"{"type":"save","config":{"tier":"pro","email":"","transcriptionEngine":"local"}}"#
            ),
            None
        );
    }

    #[test]
    fn apply_save_preserves_structured_repo_and_dedups() {
        let cur = PersistedConfig {
            repos: Some(vec![RawRepoEntry::Obj {
                id: Some("custom-id".to_string()),
                name: Some("My Web".to_string()),
                repo: "acme/web".to_string(),
                branch: Some("main".to_string()),
            }]),
            ..Default::default()
        };
        let payload = SavePayload {
            tier: "lite".to_string(),
            email: String::new(),
            transcription_engine: "local".to_string(),
            github_mode: "local".to_string(),
            repos: vec![
                "acme/web#dev".to_string(),
                "acme/new".to_string(),
                "acme/web".to_string(), // duplicate repo → dropped (finding #13)
            ],
            allowed_origins: vec![
                "https://a.example".to_string(),
                "https://a.example".to_string(), // duplicate → dropped
                "https://b.example".to_string(),
            ],
        };
        let next = apply_save(cur, payload);
        let repos = next.repos.unwrap();
        assert_eq!(repos.len(), 2, "acme/web deduped");
        // id/name preserved, branch updated to dev (finding #6); homogenized to
        // Obj because a structured entry is present.
        assert_eq!(
            repos[0],
            RawRepoEntry::Obj {
                id: Some("custom-id".to_string()),
                name: Some("My Web".to_string()),
                repo: "acme/web".to_string(),
                branch: Some("dev".to_string()),
            }
        );
        assert_eq!(
            repos[1],
            RawRepoEntry::Obj {
                id: None,
                name: None,
                repo: "acme/new".to_string(),
                branch: None,
            }
        );
        assert_eq!(
            next.allowed_origins,
            Some(vec![
                "https://a.example".to_string(),
                "https://b.example".to_string(),
            ])
        );
    }
}
