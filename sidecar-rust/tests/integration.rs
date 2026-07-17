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

    for path in ["/transcribe", "/streaming-token", "/issue"] {
        let payload = json!({ "sessionId": "cap_abc-123" });
        let resp = client
            .post(format!("{}{}", server.base, path))
            .json(&payload)
            .send()
            .unwrap();
        assert_eq!(
            resp.status(),
            501,
            "{} should return 501 for #54 stub",
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
