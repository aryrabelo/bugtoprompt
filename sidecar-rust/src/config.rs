//! Config store for the sidecar: reads and writes
//! `~/.config/bugtoprompt/config.toml` — the persisted settings the #58
//! Settings UI edits — layered under `BUGTOPROMPT_*` env vars, mirroring
//! `buildConfig()` in `server/github-issue-service.mjs`. Same env var names as
//! the Node reference so migrating an existing LaunchAgent env is a straight
//! port (PRD §14 note 4).

use std::collections::HashSet;
use std::env;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

const DEFAULT_PORT: u16 = 4127;
const DEFAULT_BRANCH: &str = "main";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Target {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing)]
    pub repo: String,
    pub branch: String,
}

/// A single `repos` entry as written in `config.toml`: either a bare
/// `"owner/repo#branch"` string or an explicit table. The Settings UI writes
/// bare strings; the table form is accepted for hand-authored files.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(untagged)]
pub enum RawRepoEntry {
    Str(String),
    Obj {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        repo: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        branch: Option<String>,
    },
}

/// On-disk `config.toml` shape — the persisted settings edited by the #58
/// Settings UI. Every field is optional so a partial or hand-written file
/// still loads, and `skip_serializing_if` keeps a saved file minimal (and
/// avoids the `toml` serializer rejecting a top-level `None`). `repos` is
/// declared last because the table form serializes to `[[repos]]`, which TOML
/// requires after all scalar keys.
#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(default)]
pub struct PersistedConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issue_mode: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub screenshot_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    // #58 additions — the Settings UI (PRD §8) reads/writes these.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tier: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transcription_engine: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assemblyai_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub github_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allowed_origins: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repos: Option<Vec<RawRepoEntry>>,
}

impl PersistedConfig {
    /// Serialize to TOML and write to `path` atomically with owner-only
    /// (0600) permissions, creating parent directories.
    ///
    /// The file holds the bearer token + AssemblyAI key, so it must not be
    /// world-readable. And the write is atomic (temp sibling + rename) so a
    /// crash mid-write leaves the previous config intact rather than a
    /// truncated file that `load_persisted` would silently reset to defaults.
    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        let text = toml::to_string_pretty(self)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        // If an existing config is present but unparseable, `load_persisted`
        // silently treated it as defaults — so overwriting here would lose a
        // hand-edited-but-broken file without a trace. Preserve it as
        // `<name>.bak` first (best effort) so the edit is recoverable.
        if path.exists() && read_toml(path).is_none() {
            let bak = bak_sibling(path);
            match std::fs::copy(path, &bak) {
                Ok(_) => tracing::warn!(
                    "backed up unparseable {} to {} before overwriting",
                    path.display(),
                    bak.display()
                ),
                Err(err) => {
                    tracing::warn!("could not back up unparseable {}: {err}", path.display())
                }
            }
        }
        // Write to a uniquely-named temp sibling (O_EXCL, fsync'd) then rename
        // atomically. `write_private` retries on a name collision (a reused PID
        // after restart could otherwise resurrect an old temp name).
        let tmp = write_private(path, text.as_bytes())?;
        if let Err(err) = std::fs::rename(&tmp, path) {
            let _ = std::fs::remove_file(&tmp);
            return Err(err);
        }
        // Durability: fsync the parent directory so the renamed entry survives
        // power loss — the rename is atomic, but its directory entry can still
        // be buffered.
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            fsync_dir(parent)?;
        }
        Ok(())
    }
}

/// Build a sibling of `path` with `.<ext>` appended to the file name
/// (`config.toml` → `config.toml.bak`). Falls back to a `config.toml` base
/// name when `path` has no file-name component.
fn sibling_with_ext(path: &Path, ext: &str) -> PathBuf {
    let mut name = path
        .file_name()
        .map(std::ffi::OsString::from)
        .unwrap_or_else(|| std::ffi::OsString::from("config.toml"));
    name.push(".");
    name.push(ext);
    path.with_file_name(name)
}

/// A `.bak` sibling of `path`, for preserving an unparseable config.
fn bak_sibling(path: &Path) -> PathBuf {
    sibling_with_ext(path, "bak")
}

/// A uniquely-named `.tmp` sibling of `path` for the atomic write. The name
/// carries the pid, a per-call counter, and a random suffix so two savers
/// (tray + sidecar) never collide — and a reused PID after a restart (counter
/// reset to 0) still can't reproduce a previous name.
fn tmp_sibling(path: &Path) -> PathBuf {
    use rand::Rng;
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let rand: u64 = rand::thread_rng().gen();
    sibling_with_ext(path, &format!("tmp.{}.{n}.{rand:016x}", std::process::id()))
}

/// Create an exclusive (`O_EXCL`, 0600 on Unix) file, retrying with a fresh
/// candidate from `next` when a name is already taken (a reused PID after a
/// restart can resurrect an old temp name). Returns the open file and its path.
fn create_exclusive(
    mut next: impl FnMut() -> PathBuf,
) -> std::io::Result<(std::fs::File, PathBuf)> {
    use std::fs::OpenOptions;
    let mut last_err = None;
    for _ in 0..16 {
        let candidate = next();
        let mut opts = OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        match opts.open(&candidate) {
            Ok(file) => return Ok((file, candidate)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => last_err = Some(e),
            Err(e) => return Err(e),
        }
    }
    Err(last_err.unwrap_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "could not create a unique temp config file",
        )
    }))
}

/// Write `bytes` to a freshly-created unique temp sibling of `path` — exclusive
/// (`O_EXCL`) creation, owner-only (0600) on Unix, and fsync — returning the
/// temp path for the caller's atomic rename. Exclusive creation (with retry on
/// a taken name) means a stale or racing temp is never silently reused, and the
/// fsync guarantees the bytes reach disk before the rename exposes the file.
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<PathBuf> {
    use std::io::Write;
    let (mut file, tmp) = create_exclusive(|| tmp_sibling(path))?;
    let result = (|| {
        // Force exactly 0600 regardless of umask.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
        }
        file.write_all(bytes)?;
        file.sync_all()
    })();
    if let Err(e) = result {
        drop(file);
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(tmp)
}

/// fsync the directory `dir` so a create/rename of an entry within it is
/// durable across power loss — the rename is atomic, but the directory entry
/// can still sit in the page cache. On macOS a plain `fsync` only reaches the
/// drive's write cache, so `F_FULLFSYNC` forces a flush to permanent storage,
/// falling back to `fsync` when the filesystem rejects it.
#[cfg(unix)]
fn fsync_dir(dir: &Path) -> std::io::Result<()> {
    let file = std::fs::File::open(dir)?;
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::io::AsRawFd;
        // F_FULLFSYNC from <sys/fcntl.h>; fcntl(fd, F_FULLFSYNC) takes no arg.
        const F_FULLFSYNC: std::ffi::c_int = 51;
        extern "C" {
            fn fcntl(fd: std::ffi::c_int, cmd: std::ffi::c_int, ...) -> std::ffi::c_int;
        }
        // SAFETY: `file` owns a valid fd for the duration of the call.
        if unsafe { fcntl(file.as_raw_fd(), F_FULLFSYNC) } == 0 {
            return Ok(());
        }
        // Unsupported (e.g. some network/FUSE FS) → fall back to plain fsync.
    }
    file.sync_all()
}

#[cfg(not(unix))]
fn fsync_dir(_dir: &Path) -> std::io::Result<()> {
    Ok(())
}

/// Resolve the persisted config path: `BUGTOPROMPT_CONFIG` override, else
/// `~/.config/bugtoprompt/config.toml`.
pub fn config_path() -> Option<PathBuf> {
    if let Ok(p) = env::var("BUGTOPROMPT_CONFIG") {
        return Some(PathBuf::from(p));
    }
    env::var_os("HOME").map(|home| {
        PathBuf::from(home)
            .join(".config")
            .join("bugtoprompt")
            .join("config.toml")
    })
}

/// Read the persisted config from [`config_path`], returning defaults when the
/// file is absent or unparseable.
pub fn load_persisted() -> PersistedConfig {
    config_path()
        .and_then(|p| read_toml(&p))
        .unwrap_or_default()
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
    /// User's transcription engine preference ("local" | "cloud"), honored by
    /// `preflight::resolve_transcription_provider`. `None` = auto.
    pub transcription_engine: Option<String>,
    pub captures_root: PathBuf,
}

impl Config {
    pub fn load() -> Self {
        Self::from_env_and_raw(load_persisted(), &EnvReader)
    }

    /// Build the effective runtime config from an in-memory persisted config
    /// (layered under the real environment), without re-reading the file. The
    /// Settings UI uses this to validate a pending save before writing it.
    pub fn from_persisted(raw: PersistedConfig) -> Self {
        Self::from_env_and_raw(raw, &EnvReader)
    }

    /// Testable core: takes the persisted file config and an env reader so
    /// tests can inject env vars without mutating the real process
    /// environment.
    fn from_env_and_raw(raw: PersistedConfig, env: &dyn EnvLookup) -> Self {
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

        // CORS allowlist is the union of the persisted `config.toml` list and
        // the `BUGTOPROMPT_ALLOWED_ORIGINS` env var, so the Settings UI (which
        // writes the file) and an env-driven deploy compose rather than one
        // silently shadowing the other.
        let mut allowed_origins: HashSet<String> = raw
            .allowed_origins
            .unwrap_or_default()
            .into_iter()
            .collect();
        if let Some(v) = env.get("BUGTOPROMPT_ALLOWED_ORIGINS") {
            allowed_origins.extend(crate::security::parse_allowed_origins(&v));
        }

        let token = env.get("BUGTOPROMPT_TOKEN").or(raw.token);

        let host = env
            .get("BUGTOPROMPT_HOST")
            .or(raw.host)
            .unwrap_or_else(|| "127.0.0.1".to_string());
        let port = env
            .get("BUGTOPROMPT_PORT")
            .and_then(|v| v.parse().ok())
            .or(raw.port)
            .unwrap_or(DEFAULT_PORT);

        let assemblyai_key = env.get("ASSEMBLYAI_API_KEY").or(raw.assemblyai_key);

        // Transcription engine preference: env `BUGTOPROMPT_TRANSCRIBE`
        // ("local" | "assemblyai"/"cloud"; "auto" or unknown → no explicit
        // preference) overrides the persisted value.
        let transcription_engine = env
            .get("BUGTOPROMPT_TRANSCRIBE")
            .and_then(|t| match t.as_str() {
                "assemblyai" | "cloud" => Some("cloud".to_string()),
                "local" | "parakeet" => Some("local".to_string()),
                _ => None,
            })
            .or(raw.transcription_engine);

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
            transcription_engine,
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

fn read_toml(path: impl AsRef<std::path::Path>) -> Option<PersistedConfig> {
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
        let cfg = Config::from_env_and_raw(PersistedConfig::default(), &MapEnv(HashMap::new()));
        assert_eq!(cfg.host, "127.0.0.1");
        assert_eq!(cfg.port, DEFAULT_PORT);
        assert!(!cfg.issue_mode);
        assert_eq!(cfg.project_id, "bugtoprompt");
        assert_eq!(cfg.enabled_modes, vec!["clipboard", "download"]);
        assert_eq!(cfg.default_mode, "clipboard");
        assert!(cfg.targets.is_empty());
        assert!(cfg.token.is_none());
        assert!(cfg.allowed_origins.is_empty());
    }

    #[test]
    fn repos_env_parses_owner_repo_hash_branch() {
        let mut env = HashMap::new();
        env.insert("BUGTOPROMPT_REPOS", "acme/web,acme/api#develop");
        let cfg = Config::from_env_and_raw(PersistedConfig::default(), &MapEnv(env));
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
        let cfg = Config::from_env_and_raw(PersistedConfig::default(), &MapEnv(env));
        assert_eq!(cfg.targets.len(), 1);
        assert_eq!(cfg.targets[0].branch, "main");
    }

    #[test]
    fn enable_issues_env_flips_modes() {
        let mut env = HashMap::new();
        env.insert("BUGTOPROMPT_ENABLE_ISSUES", "1");
        let cfg = Config::from_env_and_raw(PersistedConfig::default(), &MapEnv(env));
        assert!(cfg.issue_mode);
        assert_eq!(cfg.enabled_modes, vec!["issue", "clipboard", "download"]);
        assert_eq!(cfg.default_mode, "issue");
    }

    #[test]
    fn allowed_origins_load_from_persisted_file() {
        let raw = PersistedConfig {
            allowed_origins: Some(vec!["https://gerarposts.com.br".to_string()]),
            ..Default::default()
        };
        let cfg = Config::from_env_and_raw(raw, &MapEnv(HashMap::new()));
        assert!(cfg.allowed_origins.contains("https://gerarposts.com.br"));
    }

    #[test]
    fn allowed_origins_union_file_and_env() {
        let raw = PersistedConfig {
            allowed_origins: Some(vec!["https://a.example".to_string()]),
            ..Default::default()
        };
        let mut env = HashMap::new();
        env.insert("BUGTOPROMPT_ALLOWED_ORIGINS", "https://b.example");
        let cfg = Config::from_env_and_raw(raw, &MapEnv(env));
        assert!(cfg.allowed_origins.contains("https://a.example"));
        assert!(cfg.allowed_origins.contains("https://b.example"));
    }

    #[test]
    fn host_port_key_load_from_persisted_file() {
        let raw = PersistedConfig {
            host: Some("0.0.0.0".to_string()),
            port: Some(5000),
            assemblyai_key: Some("sk-file".to_string()),
            ..Default::default()
        };
        let cfg = Config::from_env_and_raw(raw, &MapEnv(HashMap::new()));
        assert_eq!(cfg.host, "0.0.0.0");
        assert_eq!(cfg.port, 5000);
        assert_eq!(cfg.assemblyai_key.as_deref(), Some("sk-file"));
    }

    #[test]
    fn env_overrides_file_for_host_port_key() {
        let raw = PersistedConfig {
            host: Some("0.0.0.0".to_string()),
            port: Some(5000),
            assemblyai_key: Some("sk-file".to_string()),
            ..Default::default()
        };
        let mut env = HashMap::new();
        env.insert("BUGTOPROMPT_HOST", "127.0.0.1");
        env.insert("BUGTOPROMPT_PORT", "6000");
        env.insert("ASSEMBLYAI_API_KEY", "sk-env");
        let cfg = Config::from_env_and_raw(raw, &MapEnv(env));
        assert_eq!(cfg.host, "127.0.0.1");
        assert_eq!(cfg.port, 6000);
        assert_eq!(cfg.assemblyai_key.as_deref(), Some("sk-env"));
    }

    #[test]
    fn save_then_read_round_trips_settings() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        let original = PersistedConfig {
            issue_mode: Some(true),
            tier: Some("pro".to_string()),
            transcription_engine: Some("local".to_string()),
            github_mode: Some("local".to_string()),
            allowed_origins: Some(vec![
                "https://gerarposts.com.br".to_string(),
                "http://localhost:3000".to_string(),
            ]),
            host: Some("127.0.0.1".to_string()),
            port: Some(4127),
            repos: Some(vec![RawRepoEntry::Str("acme/web".to_string())]),
            ..Default::default()
        };
        original.save(&path).unwrap();
        let round = read_toml(&path).unwrap();
        assert_eq!(round, original);

        // And the running server derives the new CORS allowlist from it.
        let cfg = Config::from_env_and_raw(round, &MapEnv(HashMap::new()));
        assert!(cfg.allowed_origins.contains("https://gerarposts.com.br"));
        assert!(cfg.allowed_origins.contains("http://localhost:3000"));
        assert_eq!(cfg.targets.len(), 1);
        assert_eq!(cfg.targets[0].id, "acme/web");
    }
    #[cfg(unix)]
    #[test]
    fn save_writes_owner_only_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        let cfg = PersistedConfig {
            token: Some("secret-bearer".to_string()),
            assemblyai_key: Some("sk-secret".to_string()),
            ..Default::default()
        };
        cfg.save(&path).unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(
            mode, 0o600,
            "config with secrets must be 0600, got {mode:o}"
        );
    }

    #[test]
    fn save_is_atomic_and_replaces_a_corrupt_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        // Simulate a prior crash that left a truncated/corrupt file.
        std::fs::write(&path, "this is not = valid toml [[[").unwrap();
        assert!(read_toml(&path).is_none(), "precondition: file is corrupt");

        let cfg = PersistedConfig {
            port: Some(4127),
            tier: Some("pro".to_string()),
            ..Default::default()
        };
        cfg.save(&path).unwrap();

        // The corrupt content is fully replaced with a complete, parseable file
        // and no uniquely-named temp sibling (.tmp.<pid>.<n>) is left behind.
        assert_eq!(read_toml(&path).unwrap(), cfg);
        let leftover_tmp = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .any(|e| e.file_name().to_string_lossy().contains(".tmp"));
        assert!(!leftover_tmp, "atomic save must not leave a temp file");

        // The unparseable original is preserved as config.toml.bak, not lost.
        let bak = dir.path().join("config.toml.bak");
        assert!(bak.exists(), "corrupt config should be backed up");
        assert_eq!(
            std::fs::read_to_string(&bak).unwrap(),
            "this is not = valid toml [[["
        );
    }

    #[test]
    fn save_does_not_back_up_a_valid_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        PersistedConfig {
            port: Some(4127),
            ..Default::default()
        }
        .save(&path)
        .unwrap();
        // Overwriting a valid config must not create a spurious .bak.
        PersistedConfig {
            port: Some(5000),
            ..Default::default()
        }
        .save(&path)
        .unwrap();
        assert!(!dir.path().join("config.toml.bak").exists());
    }

    #[test]
    fn structured_obj_repos_round_trip_through_toml() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        let cfg = PersistedConfig {
            repos: Some(vec![
                RawRepoEntry::Obj {
                    id: Some("custom-id".to_string()),
                    name: Some("My Web".to_string()),
                    repo: "acme/web".to_string(),
                    branch: Some("dev".to_string()),
                },
                // All-None fields — exactly what homogenize_repos emits for a
                // promoted bare-string row; toml would reject these without
                // skip_serializing_if.
                RawRepoEntry::Obj {
                    id: None,
                    name: None,
                    repo: "acme/api".to_string(),
                    branch: None,
                },
            ]),
            ..Default::default()
        };
        // Must not error serializing the table form (skip_serializing_if drops
        // the None fields) and must round-trip identically.
        cfg.save(&path).unwrap();
        assert_eq!(read_toml(&path).unwrap(), cfg);
    }

    #[test]
    fn tmp_sibling_names_are_unique_per_call() {
        // Concurrent savers must not share one temp path (finding: atomic save).
        let path = std::path::Path::new("/tmp/x/config.toml");
        let a = tmp_sibling(path);
        let b = tmp_sibling(path);
        assert_ne!(a, b, "each save must get its own temp file");
        assert_ne!(a, bak_sibling(path));
        assert_eq!(a.parent(), path.parent(), "temp must be a sibling");
    }

    #[test]
    fn concurrent_saves_do_not_corrupt_the_file() {
        use std::sync::Arc;
        let dir = tempfile::tempdir().unwrap();
        let path = Arc::new(dir.path().join("config.toml"));
        let handles: Vec<_> = (0..16u16)
            .map(|i| {
                let path = Arc::clone(&path);
                std::thread::spawn(move || {
                    PersistedConfig {
                        port: Some(4000 + i),
                        ..Default::default()
                    }
                    .save(&path)
                    .unwrap();
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        // Whichever writer won last, the file is a complete, parseable config —
        // never a torn/interleaved write — and no temp sibling leaks.
        let parsed = read_toml(path.as_path()).expect("final config must be parseable");
        let port = parsed.port.expect("port present");
        assert!((4000..4016).contains(&port), "unexpected port {port}");
        let leftover_tmp = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .any(|e| e.file_name().to_string_lossy().contains(".tmp"));
        assert!(
            !leftover_tmp,
            "no temp file should remain after concurrent saves"
        );
    }

    #[test]
    fn create_exclusive_retries_past_a_taken_name() {
        // A reused PID after restart can resurrect a temp name; the exclusive
        // create must skip a taken candidate and use a fresh one instead of
        // failing AlreadyExists and blocking the save.
        let dir = tempfile::tempdir().unwrap();
        let taken = dir.path().join("taken.tmp");
        std::fs::write(&taken, b"stale").unwrap();
        let fresh = dir.path().join("fresh.tmp");
        // next() yields the taken name first (→ AlreadyExists), then a free one.
        let mut candidates = vec![fresh.clone(), taken.clone()];
        let (file, got) = create_exclusive(|| candidates.pop().unwrap()).unwrap();
        assert_eq!(got, fresh, "must retry past the taken name");
        drop(file);
        assert!(fresh.exists());
        // The stale file is untouched.
        assert_eq!(std::fs::read_to_string(&taken).unwrap(), "stale");
    }

    #[test]
    fn create_exclusive_gives_up_after_persistent_collision() {
        let dir = tempfile::tempdir().unwrap();
        let taken = dir.path().join("always.tmp");
        std::fs::write(&taken, b"x").unwrap();
        // Always hand back the taken name → every attempt is AlreadyExists.
        let err = create_exclusive(|| taken.clone()).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::AlreadyExists);
    }
}
