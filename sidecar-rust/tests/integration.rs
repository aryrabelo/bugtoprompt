use std::collections::HashMap;
use std::process::Command;
use std::time::Duration;

use serde_json::{json, Value};
use tempfile::TempDir;

const BIN: &str = env!("CARGO_BIN_EXE_sidecar-rust");

struct ServerGuard {
    _child: std::process::Child,
    base: String,
    _dir: TempDir,
}

impl ServerGuard {
    fn spawn(extra_env: HashMap<&str, &str>) -> Self {
        let dir = TempDir::new().unwrap();
        let captures = dir.path().join("captures");
        let mut cmd = Command::new(BIN);
        cmd.env("BUGTOPROMPT_CAPTURES_ROOT", captures.to_str().unwrap());
        cmd.env("BUGTOPROMPT_ENABLE_ISSUES", "0");
        for (k, v) in extra_env {
            cmd.env(k, v);
        }
        // Use port 0 to get an ephemeral port.
        cmd.env("BUGTOPROMPT_PORT", "0");

        // Pre-bind a port ourselves to make the base URL deterministic, then pass
        // that port to the child. This avoids races and lets us read the port.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        cmd.env("BUGTOPROMPT_PORT", port.to_string());

        let mut child = cmd.spawn().unwrap();
        let base = format!("http://127.0.0.1:{}", port);

        // Wait for /health to become ready.
        let client = reqwest::blocking::Client::new();
        let started = std::time::Instant::now();
        loop {
            std::thread::sleep(Duration::from_millis(50));
            if let Ok(resp) = client.get(format!("{}/health", base)).send() {
                if resp.status().is_success() {
                    break;
                }
            }
            if started.elapsed() > Duration::from_secs(5) {
                let _ = child.kill();
                panic!("server did not start");
            }
        }

        Self {
            _child: child,
            base,
            _dir: dir,
        }
    }
}

impl Drop for ServerGuard {
    fn drop(&mut self) {
        let _ = self._child.kill();
    }
}

/// Write a fake `gh` executable to `dir/gh` so tests can stub the process
/// boundary without real GitHub auth. Behavior is controlled at *runtime* by
/// the `FAKE_GH_MODE` env var the script reads from its own environment:
/// unset/anything else -> success, `"unauthenticated"` -> `gh auth status`
/// and `gh issue create` both fail. `--version` always succeeds so the
/// background probe never hangs waiting on it.
fn write_fake_gh(dir: &std::path::Path) {
    let script = r#"#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "gh version 2.0.0 (fake)"
  exit 0
fi
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  [ "$FAKE_GH_MODE" = "unauthenticated" ] && exit 1
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "create" ]; then
  if [ "$FAKE_GH_MODE" = "unauthenticated" ]; then
    echo "error: not authenticated to github.com" 1>&2
    exit 1
  fi
  echo "https://github.com/acme/web/issues/42"
  exit 0
fi
exit 1
"#;
    let path = dir.join("gh");
    std::fs::write(&path, script).unwrap();
    use std::os::unix::fs::PermissionsExt;
    let mut perms = std::fs::metadata(&path).unwrap().permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(&path, perms).unwrap();
}

/// Build a PATH with `fake_bin` prepended so `gh` resolves to the fake
/// script ahead of whatever else is already on PATH.
fn path_with_fake_bin_first(fake_bin: &std::path::Path) -> String {
    format!(
        "{}:{}",
        fake_bin.display(),
        std::env::var("PATH").unwrap_or_default()
    )
}

#[test]
fn health_returns_exact_shape_and_ok_true() {
    let server = ServerGuard::spawn(HashMap::new());
    let resp = reqwest::blocking::get(format!("{}/health", server.base)).unwrap();
    assert_eq!(resp.status(), 200);
    let body: Value = resp.json().unwrap();
    assert_eq!(body["ok"], true);
    assert!(body["issues"].is_boolean());
    assert!(body["repos"].is_number());
    assert!(matches!(
        body["gh"].as_str(),
        Some("ready" | "missing" | "unauthenticated")
    ));
    assert!(matches!(
        body["transcription"].as_str(),
        Some("ready" | "local" | "unconfigured")
    ));
    assert!(body["originAllowed"].is_boolean());
}

#[test]
fn health_with_origin_query_param_reflects_origin_allowed() {
    let server = ServerGuard::spawn(HashMap::new());

    let allowed = reqwest::blocking::get(format!(
        "{}/health?origin=http%3A%2F%2Flocalhost%3A3000",
        server.base
    ))
    .unwrap();
    let body: Value = allowed.json().unwrap();
    assert_eq!(body["originAllowed"], true);

    let denied = reqwest::blocking::get(format!(
        "{}/health?origin=https%3A%2F%2Fevil.example.com",
        server.base
    ))
    .unwrap();
    let body: Value = denied.json().unwrap();
    assert_eq!(body["originAllowed"], false);
}

#[test]
fn cors_preflight_allowlisted_origin_has_acao() {
    let server = ServerGuard::spawn(HashMap::new());
    let client = reqwest::blocking::Client::new();
    let resp = client
        .request(
            reqwest::Method::OPTIONS,
            format!("{}/artifact", server.base),
        )
        .header("Origin", "http://localhost:5173")
        .send()
        .unwrap();
    assert_eq!(resp.status(), 204);
    let acao = resp.headers().get("Access-Control-Allow-Origin").unwrap();
    assert_eq!(acao.to_str().unwrap(), "http://localhost:5173");
}

#[test]
fn cors_preflight_non_allowlisted_origin_omits_acao() {
    let server = ServerGuard::spawn(HashMap::new());
    let client = reqwest::blocking::Client::new();
    let resp = client
        .request(
            reqwest::Method::OPTIONS,
            format!("{}/artifact", server.base),
        )
        .header("Origin", "https://evil.example.com")
        .send()
        .unwrap();
    // CSRF guard rejects the preflight for a non-allowlisted origin.
    assert_eq!(resp.status(), 403);
    assert!(resp.headers().get("Access-Control-Allow-Origin").is_none());
}

#[test]
fn token_configured_degrades_health_and_blocks_other_routes() {
    let mut env = HashMap::new();
    env.insert("BUGTOPROMPT_TOKEN", "secret");
    let server = ServerGuard::spawn(env);

    let degraded = reqwest::blocking::get(format!("{}/health", server.base)).unwrap();
    assert_eq!(degraded.status(), 200);
    let body: Value = degraded.json().unwrap();
    assert_eq!(body, json!({ "ok": true }));

    let client = reqwest::blocking::Client::new();
    let config_no_auth = client
        .get(format!("{}/bugtoprompt/config", server.base))
        .send()
        .unwrap();
    assert_eq!(config_no_auth.status(), 401);

    let config_with_token = client
        .get(format!("{}/bugtoprompt/config", server.base))
        .header("Authorization", "Bearer secret")
        .send()
        .unwrap();
    assert_eq!(config_with_token.status(), 200);

    let x_token = client
        .get(format!("{}/bugtoprompt/config", server.base))
        .header("x-bugtoprompt-token", "secret")
        .send()
        .unwrap();
    assert_eq!(x_token.status(), 200);
}

#[test]
fn path_traversal_session_id_rejected_with_400() {
    let server = ServerGuard::spawn(HashMap::new());
    let client = reqwest::blocking::Client::new();

    let bad = json!({
        "artifact": { "sessionId": "cap_../etc/passwd" },
    });
    let resp = client
        .post(format!("{}/artifact", server.base))
        .json(&bad)
        .send()
        .unwrap();
    assert_eq!(resp.status(), 400);

    let transcribe = json!({ "sessionId": "cap_../secret" });
    let resp = client
        .post(format!("{}/transcribe", server.base))
        .json(&transcribe)
        .send()
        .unwrap();
    assert_eq!(resp.status(), 400);
}

#[test]
fn artifact_roundtrip_persists_files() {
    let server = ServerGuard::spawn(HashMap::new());
    let client = reqwest::blocking::Client::new();

    let payload = json!({
        "artifact": {
            "sessionId": "cap_abc-123",
            "snapshots": [{ "screenshotRef": "snap-0001.jpg" }]
        },
        "audioBase64": "aGVsbG8=",
        "screenshotsBase64": ["d29ybGQ="],
    });
    let resp = client
        .post(format!("{}/artifact", server.base))
        .json(&payload)
        .send()
        .unwrap();
    assert_eq!(resp.status(), 200);
    let body: Value = resp.json().unwrap();
    let session_id = body["sessionId"].as_str().unwrap();
    assert_eq!(session_id, "cap_abc-123");

    let dir = std::path::Path::new(body["dir"].as_str().unwrap());
    assert!(dir.exists());
    assert!(dir.join("artifact.json").exists());
    assert!(dir.join("audio.webm").exists());
    assert!(dir.join("snap-0001.jpg").exists());
}

#[test]
fn stubs_return_501() {
    let server = ServerGuard::spawn(HashMap::from([
        ("BUGTOPROMPT_ENABLE_ISSUES", "1"),
        ("BUGTOPROMPT_REPOS", "acme/web"),
    ]));
    let client = reqwest::blocking::Client::new();

    // /issue is real as of #56 — see the issue_* tests below.
    for path in ["/transcribe", "/streaming-token"] {
        let payload = json!({ "sessionId": "cap_abc-123" });
        let resp = client
            .post(format!("{}{}", server.base, path))
            .json(&payload)
            .send()
            .unwrap();
        assert_eq!(
            resp.status(),
            501,
            "{} should return 501 for #54/#57 stub",
            path
        );
    }
}

#[test]
fn issue_disabled_returns_403() {
    let server = ServerGuard::spawn(HashMap::new());
    let client = reqwest::blocking::Client::new();
    let resp = client
        .post(format!("{}/issue", server.base))
        .json(&json!({ "sessionId": "cap_abc-123" }))
        .send()
        .unwrap();
    assert_eq!(resp.status(), 403);
}

#[test]
fn config_and_targets_match_contract() {
    let mut env = HashMap::new();
    env.insert("BUGTOPROMPT_ENABLE_ISSUES", "1");
    env.insert("BUGTOPROMPT_REPOS", "acme/web,acme/api#develop");
    let server = ServerGuard::spawn(env);

    let config: Value = reqwest::blocking::get(format!("{}/bugtoprompt/config", server.base))
        .unwrap()
        .json()
        .unwrap();
    assert_eq!(config["modes"], json!(["issue", "clipboard", "download"]));
    assert_eq!(config["defaultMode"], "issue");
    assert_eq!(config["projectId"], "bugtoprompt");
    assert!(config["transcriptionProvider"].is_string());

    let targets: Value =
        reqwest::blocking::get(format!("{}/targets?projectId=acme/web", server.base))
            .unwrap()
            .json()
            .unwrap();
    assert!(targets.is_array());
    assert_eq!(targets.as_array().unwrap().len(), 2);
    let first = &targets[0];
    assert_eq!(first["id"], "acme/web");
    assert_eq!(first["branch"], "main");
}

#[test]
fn issue_created_returns_created_number_and_url() {
    let fake_bin = TempDir::new().unwrap();
    write_fake_gh(fake_bin.path());
    let path = path_with_fake_bin_first(fake_bin.path());

    let mut env = HashMap::new();
    env.insert("BUGTOPROMPT_ENABLE_ISSUES", "1");
    env.insert("BUGTOPROMPT_REPOS", "acme/web");
    env.insert("PATH", path.as_str());
    let server = ServerGuard::spawn(env);

    let client = reqwest::blocking::Client::new();
    let resp = client
        .post(format!("{}/issue", server.base))
        .json(&json!({ "sessionId": "cap_abc-123", "prompt": "the button is broken" }))
        .send()
        .unwrap();
    assert_eq!(resp.status(), 200);
    let body: Value = resp.json().unwrap();
    assert_eq!(body["created"], true);
    assert_eq!(body["number"], 42);
    assert_eq!(body["url"], "https://github.com/acme/web/issues/42");
}

#[test]
fn issue_gh_missing_returns_clear_error_not_a_crash() {
    let empty_bin = TempDir::new().unwrap();

    let mut env = HashMap::new();
    env.insert("BUGTOPROMPT_ENABLE_ISSUES", "1");
    env.insert("BUGTOPROMPT_REPOS", "acme/web");
    // PATH with no `gh` on it at all — `gh issue create` must fail cleanly,
    // never crash the server.
    env.insert("PATH", empty_bin.path().to_str().unwrap());
    let server = ServerGuard::spawn(env);

    std::thread::sleep(std::time::Duration::from_millis(200));
    let health: Value = reqwest::blocking::get(format!("{}/health", server.base))
        .unwrap()
        .json()
        .unwrap();
    assert_eq!(health["gh"], "missing");

    let client = reqwest::blocking::Client::new();
    let resp = client
        .post(format!("{}/issue", server.base))
        .json(&json!({ "sessionId": "cap_abc-123" }))
        .send()
        .unwrap();
    assert_eq!(resp.status(), 502);
    let body: Value = resp.json().unwrap();
    assert!(body["error"]
        .as_str()
        .unwrap()
        .contains("gh issue create failed"));
}

#[test]
fn issue_gh_unauthenticated_returns_clear_error() {
    let fake_bin = TempDir::new().unwrap();
    write_fake_gh(fake_bin.path());
    let path = path_with_fake_bin_first(fake_bin.path());

    let mut env = HashMap::new();
    env.insert("BUGTOPROMPT_ENABLE_ISSUES", "1");
    env.insert("BUGTOPROMPT_REPOS", "acme/web");
    env.insert("PATH", path.as_str());
    env.insert("FAKE_GH_MODE", "unauthenticated");
    let server = ServerGuard::spawn(env);

    // GET /health reflects the unauthenticated gh probe too (#54's
    // detect_gh_state, exercised here against the fake binary).
    std::thread::sleep(std::time::Duration::from_millis(200));
    let health: Value = reqwest::blocking::get(format!("{}/health", server.base))
        .unwrap()
        .json()
        .unwrap();
    assert_eq!(health["gh"], "unauthenticated");

    let client = reqwest::blocking::Client::new();
    let resp = client
        .post(format!("{}/issue", server.base))
        .json(&json!({ "sessionId": "cap_abc-123" }))
        .send()
        .unwrap();
    assert_eq!(resp.status(), 502);
}

#[test]
fn issue_invalid_session_id_rejected_with_400() {
    let mut env = HashMap::new();
    env.insert("BUGTOPROMPT_ENABLE_ISSUES", "1");
    env.insert("BUGTOPROMPT_REPOS", "acme/web");
    let server = ServerGuard::spawn(env);

    let client = reqwest::blocking::Client::new();
    let resp = client
        .post(format!("{}/issue", server.base))
        .json(&json!({ "sessionId": "cap_../etc/passwd" }))
        .send()
        .unwrap();
    assert_eq!(resp.status(), 400);
}
