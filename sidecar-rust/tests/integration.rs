use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::mpsc;
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
        // Bind port 0 (OS-assigned ephemeral) *in the child*, and read the
        // port it actually bound back from stdout — no pre-bind/release/
        // rebind handoff, so no window for a sibling test to steal the port
        // between our probe and the child's bind (issue #72).
        cmd.env("BUGTOPROMPT_PORT", "0");
        cmd.stdout(Stdio::piped());

        let mut child = cmd.spawn().unwrap();
        let mut child_stdout = BufReader::new(child.stdout.take().unwrap());

        // `sidecar_rust::serve` (src/lib.rs) prints `listening on <addr>`
        // right after binding. Read it off a background thread bounded by a
        // channel timeout so a startup failure fails the test fast instead
        // of hanging on a read that never completes.
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut line = String::new();
            let port = loop {
                line.clear();
                match child_stdout.read_line(&mut line) {
                    Ok(0) => break None,
                    Ok(_) => {
                        if let Some(port) = line
                            .trim()
                            .strip_prefix("listening on 127.0.0.1:")
                            .and_then(|p| p.parse::<u16>().ok())
                        {
                            break Some(port);
                        }
                    }
                    Err(_) => break None,
                }
            };
            let _ = tx.send(port);
            // Keep draining stdout for the life of the child so it never
            // blocks writing to a full pipe once we've stopped reading.
            let mut sink = String::new();
            while child_stdout.read_line(&mut sink).unwrap_or(0) > 0 {
                sink.clear();
            }
        });

        let port = match rx.recv_timeout(Duration::from_secs(5)) {
            Ok(Some(port)) => port,
            _ => {
                let _ = child.kill();
                panic!("server did not report a listening port");
            }
        };
        let base = format!("http://127.0.0.1:{}", port);

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
        Some("local" | "unconfigured")
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
fn artifact_resave_rejects_audio_metadata_downgrade() {
    // #124 belt-and-suspenders: a re-save must not clobber a good server-side
    // audio.bytes>0 with a bytes:0 placeholder. Reject with 409 and leave the
    // prior artifact.json untouched.
    let server = ServerGuard::spawn(HashMap::new());
    let client = reqwest::blocking::Client::new();

    let good = json!({
        "artifact": {
            "sessionId": "cap_downgrade-124",
            "audio": { "ref": "audio.webm", "mimeType": "audio/webm", "bytes": 4096 }
        }
    });
    let resp = client
        .post(format!("{}/artifact", server.base))
        .json(&good)
        .send()
        .unwrap();
    assert_eq!(resp.status(), 200);
    let body: Value = resp.json().unwrap();
    let dir = std::path::PathBuf::from(body["dir"].as_str().unwrap());
    let artifact_file = dir.join("artifact.json");

    let downgrade = json!({
        "artifact": {
            "sessionId": "cap_downgrade-124",
            "audio": { "ref": "audio.webm", "mimeType": "audio/webm", "bytes": 0 }
        }
    });
    let resp = client
        .post(format!("{}/artifact", server.base))
        .json(&downgrade)
        .send()
        .unwrap();
    assert_eq!(resp.status(), 409);
    let err_body: Value = resp.json().unwrap();
    assert!(
        err_body["error"]
            .as_str()
            .unwrap_or("")
            .to_lowercase()
            .contains("downgrade"),
        "expected a downgrade error, got {err_body:?}"
    );

    // Prior audio.bytes is intact — nothing was clobbered.
    let saved: Value =
        serde_json::from_str(&std::fs::read_to_string(&artifact_file).unwrap()).unwrap();
    assert_eq!(saved["audio"]["bytes"], 4096);
}

#[test]
fn artifact_resave_allows_preserved_audio_bytes() {
    let server = ServerGuard::spawn(HashMap::new());
    let client = reqwest::blocking::Client::new();

    let good = json!({
        "artifact": {
            "sessionId": "cap_preserve-124",
            "audio": { "ref": "audio.webm", "mimeType": "audio/webm", "bytes": 4096 }
        }
    });
    for _ in 0..2 {
        let resp = client
            .post(format!("{}/artifact", server.base))
            .json(&good)
            .send()
            .unwrap();
        assert_eq!(resp.status(), 200);
    }
}

#[test]
fn artifact_concurrent_saves_never_downgrade() {
    // cubic #133 P1: two concurrent same-session saves — a finalized bytes>0
    // and a stale bytes:0 — must never leave artifact.json at bytes:0. The
    // per-session save serialization makes the outcome deterministic: whichever
    // runs first, the stale one is either rejected (prior>0 -> 409) or written
    // as the first save and then legally overwritten by the good one (prior==0).
    // Loop fresh sessions to give the scheduler room to interleave a regression
    // (i.e. a missing lock) into a bytes:0 final state.
    let server = ServerGuard::spawn(HashMap::new());
    let base = server.base.clone();

    for i in 0..10 {
        let session = format!("cap_race-{i}");
        let good = json!({
            "artifact": {
                "sessionId": session,
                "audio": { "ref": "audio.webm", "mimeType": "audio/webm", "bytes": 4096 }
            }
        });
        let stale = json!({
            "artifact": {
                "sessionId": session,
                "audio": { "ref": "audio.webm", "mimeType": "audio/webm", "bytes": 0 }
            }
        });

        let b1 = base.clone();
        let b2 = base.clone();
        let t_good = std::thread::spawn(move || {
            let c = reqwest::blocking::Client::new();
            let r = c.post(format!("{b1}/artifact")).json(&good).send().unwrap();
            let status = r.status().as_u16();
            let body: Value = r.json().unwrap();
            (status, body["dir"].as_str().map(String::from))
        });
        let t_stale = std::thread::spawn(move || {
            let c = reqwest::blocking::Client::new();
            c.post(format!("{b2}/artifact"))
                .json(&stale)
                .send()
                .unwrap()
                .status()
                .as_u16()
        });

        let (good_status, dir) = t_good.join().unwrap();
        let stale_status = t_stale.join().unwrap();

        assert_eq!(good_status, 200, "good save should succeed (iter {i})");
        assert!(
            stale_status == 200 || stale_status == 409,
            "stale save unexpected status {stale_status} (iter {i})"
        );

        // Invariant: final metadata is never the downgraded 0.
        let dir = dir.expect("good save returned a dir");
        let file = std::path::Path::new(&dir).join("artifact.json");
        let saved: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(saved["audio"]["bytes"], 4096, "downgraded on iter {i}");
    }
}

#[test]
fn streaming_token_returns_clear_cloud_mode_error() {
    let server = ServerGuard::spawn(HashMap::from([
        ("BUGTOPROMPT_ENABLE_ISSUES", "1"),
        ("BUGTOPROMPT_REPOS", "acme/web"),
    ]));
    let client = reqwest::blocking::Client::new();

    // /transcribe and /issue are real (local); cloud transcription is a Pro
    // feature served by api.bugtoprompt.com, so /streaming-token stays a 501.
    let payload = json!({ "sessionId": "cap_abc-123" });
    let resp = client
        .post(format!("{}/streaming-token", server.base))
        .json(&payload)
        .send()
        .unwrap();
    assert_eq!(
        resp.status(),
        501,
        "/streaming-token should return 501 (cloud transcription is Pro-only)"
    );
    // The error must point at cloud mode, never reference the server-side vendor.
    let body: Value = resp.json().unwrap();
    let err = body["error"].as_str().unwrap_or("");
    assert!(
        err.contains("cloud mode") || err.contains("api.bugtoprompt.com"),
        "error should point at cloud mode, got: {err}"
    );
    assert!(
        !err.to_lowercase().contains("assemblyai"),
        "error must not reference AssemblyAI, got: {err}"
    );
}

#[test]
fn transcribe_without_saved_audio_returns_400_not_501() {
    // No /artifact was ever POSTed for this session, so /transcribe must
    // reject with 400 before it ever looks at which provider is configured
    // (#55: the frozen #54 stub 501 no longer applies here).
    let server = ServerGuard::spawn(HashMap::new());
    let client = reqwest::blocking::Client::new();
    let resp = client
        .post(format!("{}/transcribe", server.base))
        .json(&json!({ "sessionId": "cap_abc-123" }))
        .send()
        .unwrap();
    assert_eq!(resp.status(), 400);
    let body: Value = resp.json().unwrap();
    assert!(body["error"].as_str().unwrap().contains("audio not found"));
}

#[test]
fn transcribe_local_path_uses_a_stubbed_engine_and_persists_batch_fallback() {
    // Fake `uvx`/`ffmpeg` on PATH (mirrors `server/service-e2e.test.mjs`):
    // succeeds on the `--version` startup probe (so /health's background
    // probe flips to "local") and, on a real run, writes parakeet-shaped
    // JSON into --output-dir.
    let bin_dir = TempDir::new().unwrap();
    let parakeet_json = json!({
        "sentences": [{
            "tokens": [
                { "text": " Hello", "start": 0.0, "end": 0.5 },
                { "text": " world.", "start": 0.6, "end": 1.2 },
            ]
        }]
    })
    .to_string();
    std::fs::write(bin_dir.path().join("ffmpeg"), "#!/bin/sh\nexit 0\n").unwrap();
    std::fs::write(
        bin_dir.path().join("uvx"),
        format!(
            "#!/bin/sh\ndir=\"\"\nprev=\"\"\nfor a in \"$@\"; do\n  if [ \"$prev\" = \"--output-dir\" ]; then dir=\"$a\"; fi\n  prev=\"$a\"\ndone\nif [ -z \"$dir\" ]; then exit 0; fi\ncat > \"$dir/audio.json\" <<'JSON'\n{parakeet_json}\nJSON\n"
        ),
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for name in ["ffmpeg", "uvx"] {
            std::fs::set_permissions(
                bin_dir.path().join(name),
                std::fs::Permissions::from_mode(0o755),
            )
            .unwrap();
        }
    }
    // Prepend the fake bin dir so it shadows any real uvx/ffmpeg on this
    // host, matching the Node e2e test's PATH strategy exactly.
    let path_env = format!(
        "{}:{}",
        bin_dir.path().display(),
        std::env::var("PATH").unwrap()
    );
    let mut env = HashMap::new();
    env.insert("PATH", path_env.as_str());
    let server = ServerGuard::spawn(env);

    // ServerGuard only waits for /health to answer 200 — the transcription
    // background probe can still be in flight, so poll until it flips to
    // "local" (mirrors service-e2e.test.mjs's readiness loop).
    let client = reqwest::blocking::Client::new();
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        let body: Value = client
            .get(format!("{}/health", server.base))
            .send()
            .unwrap()
            .json()
            .unwrap();
        if body["transcription"] == "local" {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "transcription state never became \"local\""
        );
        std::thread::sleep(Duration::from_millis(50));
    }

    let artifact_resp = client
        .post(format!("{}/artifact", server.base))
        .json(&json!({
            "artifact": { "sessionId": "cap_transcribe-1" },
            "audioBase64": "ZmFrZS13ZWJtLWJ5dGVz",
        }))
        .send()
        .unwrap();
    assert_eq!(artifact_resp.status(), 200);

    let resp = client
        .post(format!("{}/transcribe", server.base))
        .json(&json!({ "sessionId": "cap_transcribe-1" }))
        .send()
        .unwrap();
    assert_eq!(resp.status(), 200);
    let body: Value = resp.json().unwrap();
    assert_eq!(
        body["transcript"],
        json!([{ "tStartMs": 0, "tEndMs": 1200, "text": "Hello world." }])
    );

    let artifact_dir = std::path::Path::new(
        artifact_resp.json::<Value>().unwrap()["dir"]
            .as_str()
            .unwrap(),
    )
    .to_path_buf();
    let artifact: Value =
        serde_json::from_str(&std::fs::read_to_string(artifact_dir.join("artifact.json")).unwrap())
            .unwrap();
    assert_eq!(artifact["transcriptionMode"], "batch-fallback");
    assert_eq!(artifact["transcript"], body["transcript"]);
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
