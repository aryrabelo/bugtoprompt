//! Config loading: `config.toml` (stub store for #58) layered under
//! `BUGTOPROMPT_*` env vars, mirroring `buildConfig()` in
//! `server/github-issue-service.mjs`. Same env var names as the Node
//! reference so migrating an existing LaunchAgent env is a straight port
//! (PRD §14 note 4).

use std::collections::HashSet;
use std::env;
use std::path::PathBuf;

use serde::Deserialize;

const DEFAULT_PORT: u16 = 4127;
const DEFAULT_BRANCH: &str = "main";

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Target {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing)]
    pub repo: String,
    pub branch: String,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum RawRepoEntry {
    Str(String),
    Obj {
        id: Option<String>,
        name: Option<String>,
        repo: String,
        branch: Option<String>,
    },
}

/// `config.toml` shape — a stub for the real config store #58 owns.
#[derive(Debug, Default, Deserialize)]
struct RawConfig {
    issue_mode: Option<bool>,
    project_id: Option<String>,
    screenshot_mode: Option<String>,
    env: Option<String>,
    default_mode: Option<String>,
    repos: Option<Vec<RawRepoEntry>>,
    token: Option<String>,
}

fn normalize_repo(entry: &RawRepoEntry) -> Option<Target> {
    match entry {
        RawRepoEntry::Str(raw) => {
            let mut parts = raw.splitn(2, '#');
            let repo = parts.next().unwrap_or("").trim().to_string();
            if repo.is_empty() {
                return None;
            }
            let branch = parts
                .next()
                .map(str::trim)
                .filter(|b| !b.is_empty())
                .unwrap_or(DEFAULT_BRANCH)
                .to_string();
            Some(Target {
                id: repo.clone(),
                name: repo.clone(),
                repo,
                branch,
            })
        }
        RawRepoEntry::Obj {
            id,
            name,
            repo,
            branch,
        } => {
            let repo = repo.trim().to_string();
            if repo.is_empty() {
                return None;
            }
            let id = id.as_deref().unwrap_or(&repo).trim().to_string();
            let name = name.as_deref().unwrap_or(&repo).trim().to_string();
            let branch = branch
                .as_deref()
                .map(str::trim)
                .filter(|b| !b.is_empty())
                .unwrap_or(DEFAULT_BRANCH)
                .to_string();
            Some(Target {
                id,
                name,
                repo,
                branch,
            })
        }
    }
}

#[derive(Debug, Clone)]
pub struct Config {
    pub host: String,
    pub port: u16,
    pub issue_mode: bool,
    pub targets: Vec<Target>,
    pub project_id: String,
    pub screenshot_mode: Option<String>,
    pub env: Option<String>,
    pub enabled_modes: Vec<&'static str>,
    pub default_mode: String,
    pub allowed_origins: HashSet<String>,
    pub token: Option<String>,
    pub assemblyai_key: Option<String>,
    pub captures_root: PathBuf,
}

impl Config {
    pub fn load() -> Self {
        Self::from_env_and_raw(load_raw_config(), &EnvReader)
    }

    /// Testable core: takes the raw file config and an env reader so tests
    /// can inject env vars without mutating the real process environment.
    fn from_env_and_raw(raw: RawConfig, env: &dyn EnvLookup) -> Self {
        let issue_mode = raw.issue_mode == Some(true)
            || env.get("BUGTOPROMPT_ENABLE_ISSUES").as_deref() == Some("1");

        let mut entries: Vec<RawRepoEntry> = raw.repos.unwrap_or_default();
        if let Some(repos_env) = env.get("BUGTOPROMPT_REPOS") {
            for s in repos_env.split(',') {
                let s = s.trim();
                if !s.is_empty() {
                    entries.push(RawRepoEntry::Str(s.to_string()));
                }
            }
        }
        let mut targets = Vec::new();
        let mut seen_ids = HashSet::new();
        for entry in &entries {
            if let Some(t) = normalize_repo(entry) {
                if seen_ids.insert(t.id.clone()) {
                    targets.push(t);
                }
            }
        }

        let project_id = raw
            .project_id
            .or_else(|| env.get("BUGTOPROMPT_PROJECT_ID"))
            .unwrap_or_else(|| "bugtoprompt".to_string());
        let screenshot_mode = raw
            .screenshot_mode
            .or_else(|| env.get("BUGTOPROMPT_SCREENSHOT_MODE"));
        let env_label = raw.env.or_else(|| env.get("BUGTOPROMPT_ENV"));

        let enabled_modes: Vec<&'static str> = if issue_mode {
            vec!["issue", "clipboard", "download"]
        } else {
            vec!["clipboard", "download"]
        };
        let default_mode = raw
            .default_mode
            .unwrap_or_else(|| if issue_mode { "issue" } else { "clipboard" }.to_string());

        let allowed_origins = env
            .get("BUGTOPROMPT_ALLOWED_ORIGINS")
            .map(|v| crate::security::parse_allowed_origins(&v))
            .unwrap_or_default();

        let token = env.get("BUGTOPROMPT_TOKEN").or(raw.token);

        let host = env
            .get("BUGTOPROMPT_HOST")
            .unwrap_or_else(|| "127.0.0.1".to_string());
        let port = env
            .get("BUGTOPROMPT_PORT")
            .and_then(|v| v.parse().ok())
            .unwrap_or(DEFAULT_PORT);

        let assemblyai_key = env.get("ASSEMBLYAI_API_KEY");

        // ponytail: testability-only override, not part of the frozen wire
        // contract. Node has no equivalent — it always writes under
        // `process.cwd()/.bugtoprompt/captures`; production keeps that
        // default, tests point it at a tempdir instead of littering the repo.
        let captures_root = env
            .get("BUGTOPROMPT_CAPTURES_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                env::current_dir()
                    .unwrap_or_else(|_| PathBuf::from("."))
                    .join(".bugtoprompt")
                    .join("captures")
            });

        Config {
            host,
            port,
            issue_mode,
            targets,
            project_id,
            screenshot_mode,
            env: env_label,
            enabled_modes,
            default_mode,
            allowed_origins,
            token,
            assemblyai_key,
            captures_root,
        }
    }
}

trait EnvLookup {
    fn get(&self, key: &str) -> Option<String>;
}

struct EnvReader;

impl EnvLookup for EnvReader {
    fn get(&self, key: &str) -> Option<String> {
        env::var(key).ok()
    }
}

fn load_raw_config() -> RawConfig {
    if let Ok(path) = env::var("BUGTOPROMPT_CONFIG") {
        return read_toml(&path).unwrap_or_default();
    }
    if let Some(home) = env::var_os("HOME") {
        let default_path = PathBuf::from(home)
            .join(".config")
            .join("bugtoprompt")
            .join("config.toml");
        if let Some(cfg) = read_toml(&default_path) {
            return cfg;
        }
    }
    RawConfig::default()
}

fn read_toml(path: impl AsRef<std::path::Path>) -> Option<RawConfig> {
    let path = path.as_ref();
    let text = std::fs::read_to_string(path).ok()?;
    match toml::from_str(&text) {
        Ok(cfg) => Some(cfg),
        Err(err) => {
            tracing::warn!("failed to parse config file at {}: {}", path.display(), err);
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    struct MapEnv(HashMap<&'static str, &'static str>);
    impl EnvLookup for MapEnv {
        fn get(&self, key: &str) -> Option<String> {
            self.0.get(key).map(|v| v.to_string())
        }
    }

    #[test]
    fn defaults_are_the_node_reference_defaults() {
        let cfg = Config::from_env_and_raw(RawConfig::default(), &MapEnv(HashMap::new()));
        assert_eq!(cfg.host, "127.0.0.1");
        assert_eq!(cfg.port, DEFAULT_PORT);
        assert!(!cfg.issue_mode);
        assert_eq!(cfg.project_id, "bugtoprompt");
        assert_eq!(cfg.enabled_modes, vec!["clipboard", "download"]);
        assert_eq!(cfg.default_mode, "clipboard");
        assert!(cfg.targets.is_empty());
        assert!(cfg.token.is_none());
    }

    #[test]
    fn repos_env_parses_owner_repo_hash_branch() {
        let mut env = HashMap::new();
        env.insert("BUGTOPROMPT_REPOS", "acme/web,acme/api#develop");
        let cfg = Config::from_env_and_raw(RawConfig::default(), &MapEnv(env));
        assert_eq!(cfg.targets.len(), 2);
        assert_eq!(cfg.targets[0].id, "acme/web");
        assert_eq!(cfg.targets[0].branch, "main");
        assert_eq!(cfg.targets[1].id, "acme/api");
        assert_eq!(cfg.targets[1].branch, "develop");
    }

    #[test]
    fn repos_dedup_by_id_keeps_first() {
        let mut env = HashMap::new();
        env.insert("BUGTOPROMPT_REPOS", "acme/web,acme/web#other");
        let cfg = Config::from_env_and_raw(RawConfig::default(), &MapEnv(env));
        assert_eq!(cfg.targets.len(), 1);
        assert_eq!(cfg.targets[0].branch, "main");
    }

    #[test]
    fn enable_issues_env_flips_modes() {
        let mut env = HashMap::new();
        env.insert("BUGTOPROMPT_ENABLE_ISSUES", "1");
        let cfg = Config::from_env_and_raw(RawConfig::default(), &MapEnv(env));
        assert!(cfg.issue_mode);
        assert_eq!(cfg.enabled_modes, vec!["issue", "clipboard", "download"]);
        assert_eq!(cfg.default_mode, "issue");
    }
}
