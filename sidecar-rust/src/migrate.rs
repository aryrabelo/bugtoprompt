//! One-time first-run migration (PRD §14 note 4): import an existing macOS
//! LaunchAgent plist's `EnvironmentVariables` — the Node sidecar's config — into
//! `config.toml`, so upgrading users keep their setup without hand-editing a
//! file. Runs once: it is a no-op as soon as a `config.toml` exists.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use plist::Value;

use crate::config::{PersistedConfig, RawRepoEntry};

/// Default LaunchAgent plist path the Node sidecar was installed under.
pub fn default_launch_agent_path() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|home| {
        PathBuf::from(home)
            .join("Library")
            .join("LaunchAgents")
            .join("com.bugtoprompt.sidecar.plist")
    })
}

/// Read the `EnvironmentVariables` string map from a LaunchAgent plist. Returns
/// an empty map when the file is absent, unreadable, or carries no env dict.
fn read_plist_env(plist_path: &Path) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let Ok(value) = Value::from_file(plist_path) else {
        return out;
    };
    let Some(dict) = value.as_dictionary() else {
        return out;
    };
    let Some(env) = dict
        .get("EnvironmentVariables")
        .and_then(Value::as_dictionary)
    else {
        return out;
    };
    for (k, v) in env {
        if let Some(s) = v.as_string() {
            out.insert(k.clone(), s.to_string());
        }
    }
    out
}

/// The legacy Node `BUGTOPROMPT_CONFIG` JSON shape (camelCase), a subset of
/// `loadRawConfig()`/`buildConfig()` in `server/github-issue-service.mjs`.
#[derive(Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyJsonConfig {
    issue_mode: Option<bool>,
    repos: Option<Vec<serde_json::Value>>,
    project_id: Option<String>,
    screenshot_mode: Option<String>,
    env: Option<String>,
    default_mode: Option<String>,
}

/// Parse the legacy `BUGTOPROMPT_CONFIG` env value — inline JSON (`{...}`) or a
/// path to a JSON file — mirroring the Node sidecar's `loadRawConfig()`.
fn read_legacy_config(env: &BTreeMap<String, String>) -> Option<LegacyJsonConfig> {
    let raw = env.get("BUGTOPROMPT_CONFIG")?.trim().to_string();
    if raw.is_empty() {
        return None;
    }
    let text = if raw.starts_with('{') {
        raw
    } else {
        std::fs::read_to_string(&raw).ok()?
    };
    match serde_json::from_str(&text) {
        Ok(cfg) => Some(cfg),
        Err(err) => {
            tracing::warn!("failed to parse legacy BUGTOPROMPT_CONFIG: {err}");
            None
        }
    }
}

/// Convert one legacy JSON `repos` entry into a [`RawRepoEntry`]. Accepts a
/// bare `"owner/repo#branch"` string or a Node-shaped object keyed by either
/// `repo` or `id` — a legacy `{ "id": "owner/repo" }` must NOT discard the
/// whole migration. Entries carrying no usable repo are dropped, not fatal.
fn legacy_repo_entry(value: &serde_json::Value) -> Option<RawRepoEntry> {
    if let Some(s) = value.as_str() {
        let s = s.trim();
        return (!s.is_empty()).then(|| RawRepoEntry::Str(s.to_string()));
    }
    let obj = value.as_object()?;
    let str_field = |k: &str| {
        obj.get(k)
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    let repo = str_field("repo").or_else(|| str_field("id"))?;
    // Preserve a custom target `id` only when a distinct `repo` was given; when
    // `id` merely stood in as the repo (the `{ "id": ... }` fallback), there is
    // no separate custom id. Dropping a real custom id would change target
    // identity and can collapse distinct targets that de-dupe by ID.
    let id = str_field("repo").and_then(|_| str_field("id"));
    Some(RawRepoEntry::Obj {
        id,
        name: str_field("name"),
        repo,
        branch: str_field("branch"),
    })
}

/// Build a [`PersistedConfig`] from LaunchAgent env vars. A legacy
/// `BUGTOPROMPT_CONFIG` JSON (finding #3) forms the base; individual
/// `BUGTOPROMPT_*` env vars overlay on top (present-only, never clobbering a
/// legacy value with `None`), matching the Node env precedence.
pub fn config_from_launch_agent_env(env: &BTreeMap<String, String>) -> PersistedConfig {
    let get = |k: &str| env.get(k).cloned().filter(|s| !s.is_empty());
    let split_list = |raw: String| -> Vec<String> {
        raw.split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect()
    };

    let mut cfg = PersistedConfig::default();
    if let Some(legacy) = read_legacy_config(env) {
        cfg.issue_mode = legacy.issue_mode;
        cfg.project_id = legacy.project_id;
        cfg.screenshot_mode = legacy.screenshot_mode;
        cfg.env = legacy.env;
        cfg.default_mode = legacy.default_mode;
        cfg.repos = legacy.repos.and_then(|entries| {
            let list: Vec<RawRepoEntry> = entries.iter().filter_map(legacy_repo_entry).collect();
            (!list.is_empty()).then_some(list)
        });
    }

    if env.get("BUGTOPROMPT_ENABLE_ISSUES").map(String::as_str) == Some("1") {
        cfg.issue_mode = Some(true);
    }
    if let Some(v) = get("BUGTOPROMPT_PROJECT_ID") {
        cfg.project_id = Some(v);
    }
    if let Some(v) = get("BUGTOPROMPT_SCREENSHOT_MODE") {
        cfg.screenshot_mode = Some(v);
    }
    if let Some(v) = get("BUGTOPROMPT_ENV") {
        cfg.env = Some(v);
    }
    if let Some(v) = get("BUGTOPROMPT_TOKEN") {
        cfg.token = Some(v);
    }
    if let Some(v) = get("BUGTOPROMPT_HOST") {
        cfg.host = Some(v);
    }
    // Treat 0 (or an unparseable value) as absent so the legacy default port
    // (4127) is used instead of an ephemeral OS-assigned port.
    if let Some(v) = get("BUGTOPROMPT_PORT")
        .and_then(|p| p.parse::<u16>().ok())
        .filter(|&p| p != 0)
    {
        cfg.port = Some(v);
    }
    if let Some(v) = get("ASSEMBLYAI_API_KEY") {
        cfg.assemblyai_key = Some(v);
    }

    // Preserve the legacy transcription preference (finding #12) instead of
    // silently falling back to local when uvx is present.
    if let Some(t) = get("BUGTOPROMPT_TRANSCRIBE") {
        cfg.transcription_engine = match t.as_str() {
            "assemblyai" | "cloud" => Some("cloud".to_string()),
            "local" | "parakeet" => Some("local".to_string()),
            _ => None, // "auto" / unknown → no explicit preference
        };
    }

    if let Some(origins) = get("BUGTOPROMPT_ALLOWED_ORIGINS") {
        let list = split_list(origins);
        if !list.is_empty() {
            cfg.allowed_origins = Some(list);
        }
    }

    // Repos: legacy `repos` (base) plus env `BUGTOPROMPT_REPOS` appended,
    // mirroring the Node buildConfig merge order.
    if let Some(repos) = get("BUGTOPROMPT_REPOS") {
        let mut list = cfg.repos.take().unwrap_or_default();
        list.extend(split_list(repos).into_iter().map(RawRepoEntry::Str));
        if !list.is_empty() {
            cfg.repos = Some(list);
        }
    }

    cfg
}

/// Import a LaunchAgent plist's env into `config_path`, but only if the config
/// file does not already exist (one-time) and the plist contributes at least
/// one setting. Returns `Ok(true)` when a config file was written.
pub fn migrate_from_launch_agent(plist_path: &Path, config_path: &Path) -> std::io::Result<bool> {
    if config_path.exists() {
        return Ok(false);
    }
    let env = read_plist_env(plist_path);
    if env.is_empty() {
        return Ok(false);
    }
    let cfg = config_from_launch_agent_env(&env);
    if cfg == PersistedConfig::default() {
        return Ok(false);
    }
    cfg.save(config_path)?;
    Ok(true)
}

/// First-run migration using the default LaunchAgent + config paths. Best
/// effort: logs and continues on any error so a malformed plist never blocks
/// startup. Call once from the host app's `main` before `Config::load()`.
pub fn run_first_run_migration() {
    let (Some(plist), Some(config)) = (default_launch_agent_path(), crate::config::config_path())
    else {
        return;
    };
    match migrate_from_launch_agent(&plist, &config) {
        Ok(true) => tracing::info!("migrated LaunchAgent env into {}", config.display()),
        Ok(false) => {}
        Err(err) => tracing::warn!("LaunchAgent migration skipped: {err}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE_PLIST: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.bugtoprompt.sidecar</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>BUGTOPROMPT_ENABLE_ISSUES</key>
        <string>1</string>
        <key>BUGTOPROMPT_REPOS</key>
        <string>gerarposts, aryrabelo/bugtoprompt#main</string>
        <key>BUGTOPROMPT_ALLOWED_ORIGINS</key>
        <string>https://gerarposts.com.br,http://localhost:3000</string>
        <key>ASSEMBLYAI_API_KEY</key>
        <string>sk-assembly-123</string>
        <key>BUGTOPROMPT_PORT</key>
        <string>4127</string>
    </dict>
</dict>
</plist>
"#;

    #[test]
    fn imports_launch_agent_env_into_config_toml() {
        let dir = tempfile::tempdir().unwrap();
        let plist = dir.path().join("com.bugtoprompt.sidecar.plist");
        let config = dir.path().join("config.toml");
        std::fs::write(&plist, FIXTURE_PLIST).unwrap();

        let migrated = migrate_from_launch_agent(&plist, &config).unwrap();
        assert!(
            migrated,
            "should migrate when config is absent and plist has env"
        );
        assert!(config.exists());

        // Assert on the resulting TOML content.
        let text = std::fs::read_to_string(&config).unwrap();
        assert!(text.contains("issue_mode = true"), "toml:\n{text}");
        assert!(
            text.contains("assemblyai_key = \"sk-assembly-123\""),
            "toml:\n{text}"
        );
        assert!(text.contains("https://gerarposts.com.br"), "toml:\n{text}");
        assert!(text.contains("http://localhost:3000"), "toml:\n{text}");

        // And it parses back into the expected structured config.
        let parsed: PersistedConfig = toml::from_str(&text).unwrap();
        assert_eq!(parsed.issue_mode, Some(true));
        assert_eq!(parsed.port, Some(4127));
        assert_eq!(parsed.assemblyai_key.as_deref(), Some("sk-assembly-123"));
        assert_eq!(
            parsed.allowed_origins,
            Some(vec![
                "https://gerarposts.com.br".to_string(),
                "http://localhost:3000".to_string(),
            ])
        );
        assert_eq!(
            parsed.repos,
            Some(vec![
                RawRepoEntry::Str("gerarposts".to_string()),
                RawRepoEntry::Str("aryrabelo/bugtoprompt#main".to_string()),
            ])
        );
    }

    #[test]
    fn does_not_overwrite_existing_config() {
        let dir = tempfile::tempdir().unwrap();
        let plist = dir.path().join("agent.plist");
        let config = dir.path().join("config.toml");
        std::fs::write(&plist, FIXTURE_PLIST).unwrap();
        std::fs::write(&config, "port = 9999\n").unwrap();

        let migrated = migrate_from_launch_agent(&plist, &config).unwrap();
        assert!(!migrated, "must not clobber an existing config.toml");
        assert_eq!(std::fs::read_to_string(&config).unwrap(), "port = 9999\n");
    }

    #[test]
    fn no_migration_when_plist_absent() {
        let dir = tempfile::tempdir().unwrap();
        let plist = dir.path().join("missing.plist");
        let config = dir.path().join("config.toml");
        let migrated = migrate_from_launch_agent(&plist, &config).unwrap();
        assert!(!migrated);
        assert!(!config.exists());
    }
    #[test]
    fn merges_legacy_bugtoprompt_config_file_and_transcribe_pref() {
        let dir = tempfile::tempdir().unwrap();
        let legacy = dir.path().join("legacy.github.json");
        std::fs::write(
            &legacy,
            r#"{"issueMode":true,"projectId":"legacy-proj","repos":["acme/web","acme/api#dev"]}"#,
        )
        .unwrap();
        let plist_body = format!(
            concat!(
                "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n",
                "<plist version=\"1.0\"><dict>\n",
                "<key>EnvironmentVariables</key><dict>\n",
                "<key>BUGTOPROMPT_CONFIG</key><string>{}</string>\n",
                "<key>BUGTOPROMPT_TRANSCRIBE</key><string>assemblyai</string>\n",
                "<key>BUGTOPROMPT_REPOS</key><string>extra/repo</string>\n",
                "</dict></dict></plist>\n"
            ),
            legacy.display()
        );
        let plist = dir.path().join("agent.plist");
        let config = dir.path().join("config.toml");
        std::fs::write(&plist, plist_body).unwrap();

        assert!(migrate_from_launch_agent(&plist, &config).unwrap());
        let parsed: PersistedConfig =
            toml::from_str(&std::fs::read_to_string(&config).unwrap()).unwrap();
        // Legacy JSON fields imported (finding #3)...
        assert_eq!(parsed.issue_mode, Some(true));
        assert_eq!(parsed.project_id.as_deref(), Some("legacy-proj"));
        // ...legacy transcribe preference preserved as cloud (finding #12)...
        assert_eq!(parsed.transcription_engine.as_deref(), Some("cloud"));
        // ...and env BUGTOPROMPT_REPOS appended after the legacy repos.
        assert_eq!(
            parsed.repos,
            Some(vec![
                RawRepoEntry::Str("acme/web".to_string()),
                RawRepoEntry::Str("acme/api#dev".to_string()),
                RawRepoEntry::Str("extra/repo".to_string()),
            ])
        );
    }

    #[test]
    fn parses_inline_legacy_json_and_transcribe() {
        let mut env = BTreeMap::new();
        env.insert(
            "BUGTOPROMPT_CONFIG".to_string(),
            r#"{"issueMode":true,"repos":["a/b"]}"#.to_string(),
        );
        env.insert("BUGTOPROMPT_TRANSCRIBE".to_string(), "local".to_string());
        let cfg = config_from_launch_agent_env(&env);
        assert_eq!(cfg.issue_mode, Some(true));
        assert_eq!(cfg.repos, Some(vec![RawRepoEntry::Str("a/b".to_string())]));
        assert_eq!(cfg.transcription_engine.as_deref(), Some("local"));
    }

    #[test]
    fn legacy_repo_id_fallback_preserves_migration() {
        // A legacy `{ "id": "owner/repo" }` repo must not discard the whole
        // JSON migration (project_id, issue_mode, etc.).
        let mut env = BTreeMap::new();
        env.insert(
            "BUGTOPROMPT_CONFIG".to_string(),
            r#"{"issueMode":true,"projectId":"p","repos":[{"id":"acme/web"},{"id":"acme/api","branch":"dev"}]}"#
                .to_string(),
        );
        let cfg = config_from_launch_agent_env(&env);
        assert_eq!(cfg.issue_mode, Some(true));
        assert_eq!(cfg.project_id.as_deref(), Some("p"));
        assert_eq!(
            cfg.repos,
            Some(vec![
                RawRepoEntry::Obj {
                    id: None,
                    name: None,
                    repo: "acme/web".to_string(),
                    branch: None,
                },
                RawRepoEntry::Obj {
                    id: None,
                    name: None,
                    repo: "acme/api".to_string(),
                    branch: Some("dev".to_string()),
                },
            ])
        );
    }

    #[test]
    fn legacy_unsupported_repo_entries_are_filtered_not_fatal() {
        let mut env = BTreeMap::new();
        env.insert(
            "BUGTOPROMPT_CONFIG".to_string(),
            r#"{"issueMode":true,"repos":[{"unknown":"x"},"a/b",{"id":"c/d"}]}"#.to_string(),
        );
        let cfg = config_from_launch_agent_env(&env);
        assert_eq!(cfg.issue_mode, Some(true), "migration kept");
        assert_eq!(
            cfg.repos,
            Some(vec![
                RawRepoEntry::Str("a/b".to_string()),
                RawRepoEntry::Obj {
                    id: None,
                    name: None,
                    repo: "c/d".to_string(),
                    branch: None,
                },
            ])
        );
    }

    #[test]
    fn port_zero_is_ignored_falls_back_to_default() {
        let mut env = BTreeMap::new();
        env.insert("BUGTOPROMPT_PORT".to_string(), "0".to_string());
        assert_eq!(
            config_from_launch_agent_env(&env).port,
            None,
            "PORT=0 must not be imported"
        );

        let mut env2 = BTreeMap::new();
        env2.insert("BUGTOPROMPT_PORT".to_string(), "4127".to_string());
        assert_eq!(config_from_launch_agent_env(&env2).port, Some(4127));
    }

    #[test]
    fn legacy_repo_preserves_custom_id_distinct_from_repo() {
        // `{ "id": "custom", "repo": "owner/repo" }` — the custom target id must
        // survive so config de-dup by ID doesn't collapse distinct targets.
        let mut env = BTreeMap::new();
        env.insert(
            "BUGTOPROMPT_CONFIG".to_string(),
            r#"{"repos":[{"id":"custom","repo":"owner/repo","branch":"dev"}]}"#.to_string(),
        );
        let cfg = config_from_launch_agent_env(&env);
        assert_eq!(
            cfg.repos,
            Some(vec![RawRepoEntry::Obj {
                id: Some("custom".to_string()),
                name: None,
                repo: "owner/repo".to_string(),
                branch: Some("dev".to_string()),
            }])
        );
    }
}
