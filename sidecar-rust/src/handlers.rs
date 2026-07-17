//! Route handlers. `GET /health` is NOT registered here — it is handled
//! entirely inside `mw::cors_csrf_auth`, which mirrors the Node reference's
//! placement of `/health` BEFORE the CSRF/auth gate (see that module).

use std::collections::HashSet;

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Json, Response};
use base64::Engine;
use serde_json::{json, Value};

use crate::security;
use crate::state::AppState;

fn json_response(status: StatusCode, body: Value) -> Response {
    (status, Json(body)).into_response()
}

/// Read + parse a JSON body, mirroring `readJsonBody`: an empty body is `{}`,
/// anything else must parse as JSON. A read/parse failure surfaces as `500`,
/// matching the Node reference's `dispatch().catch(err) -> 500`.
async fn read_json_body(body: Body) -> Result<Value, Response> {
    const MAX_BODY_BYTES: usize = 64 * 1024 * 1024;
    let bytes = axum::body::to_bytes(body, MAX_BODY_BYTES)
        .await
        .map_err(|err| {
            json_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                json!({ "error": err.to_string() }),
            )
        })?;
    if bytes.is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_slice(&bytes).map_err(|err| {
        json_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "error": err.to_string() }),
        )
    })
}

pub async fn not_found() -> Response {
    json_response(StatusCode::NOT_FOUND, json!({ "error": "not found" }))
}

pub async fn get_config(State(state): State<AppState>) -> Response {
    let provider = *state.transcription_provider.read();
    let mut body = json!({
        "modes": state.config.enabled_modes,
        "defaultMode": state.config.default_mode,
        "projectId": state.config.project_id,
        "transcriptionProvider": provider,
    });
    if let Some(screenshot_mode) = &state.config.screenshot_mode {
        body["screenshotMode"] = json!(screenshot_mode);
    }
    if let Some(env) = &state.config.env {
        body["env"] = json!(env);
    }
    json_response(StatusCode::OK, body)
}

/// `GET /targets?projectId=` — the query param is accepted (and ignored) for
/// contract compatibility; the Node reference ignores it too, always
/// returning every configured target.
pub async fn get_targets(State(state): State<AppState>) -> Response {
    let targets: Vec<Value> = state
        .config
        .targets
        .iter()
        .map(|t| json!({ "id": t.id, "name": t.name, "branch": t.branch }))
        .collect();
    json_response(StatusCode::OK, Value::Array(targets))
}

pub async fn post_artifact(State(state): State<AppState>, req: Request) -> Response {
    let body = match read_json_body(req.into_body()).await {
        Ok(v) => v,
        Err(resp) => return resp,
    };

    let artifact = body.get("artifact");
    let session_id = artifact
        .and_then(|a| a.get("sessionId"))
        .and_then(Value::as_str);
    let Some(session_id) = session_id else {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({ "error": "artifact.sessionId required" }),
        );
    };
    if !security::is_valid_session_id(session_id) {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({ "error": "invalid sessionId" }),
        );
    }

    // Validate the FULL screenshot payload BEFORE creating the dir or writing
    // anything, so a rejected capture never leaves a partial dir behind.
    let mut to_write: Vec<(String, String)> = Vec::new();
    let mut seen_refs: HashSet<String> = HashSet::new();
    if let Some(screenshots) = body.get("screenshotsBase64").and_then(Value::as_array) {
        let snapshots = artifact
            .and_then(|a| a.get("snapshots"))
            .and_then(Value::as_array);
        for (i, b64_value) in screenshots.iter().enumerate() {
            let Some(b64) = b64_value.as_str() else {
                continue;
            };
            if b64.is_empty() {
                continue;
            }
            let screenshot_ref = snapshots
                .and_then(|s| s.get(i))
                .and_then(|s| s.get("screenshotRef"))
                .and_then(Value::as_str);
            let Some(screenshot_ref) =
                screenshot_ref.filter(|r| security::is_valid_screenshot_ref(r))
            else {
                return json_response(
                    StatusCode::BAD_REQUEST,
                    json!({ "error": format!("screenshot {i} missing a valid screenshotRef (expected snap-NNNN.jpg)") }),
                );
            };
            if !seen_refs.insert(screenshot_ref.to_string()) {
                return json_response(
                    StatusCode::BAD_REQUEST,
                    json!({ "error": format!("screenshot {i} reuses screenshotRef {screenshot_ref}; each ref must be unique") }),
                );
            }
            to_write.push((screenshot_ref.to_string(), b64.to_string()));
        }
    }

    let dir = state.config.captures_root.join(session_id);
    if let Err(err) = tokio::fs::create_dir_all(&dir).await {
        return json_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "error": err.to_string() }),
        );
    }

    let artifact_json = match serde_json::to_string_pretty(artifact.unwrap_or(&Value::Null)) {
        Ok(s) => s,
        Err(err) => {
            return json_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                json!({ "error": err.to_string() }),
            )
        }
    };
    if let Err(err) = tokio::fs::write(dir.join("artifact.json"), artifact_json).await {
        return json_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "error": err.to_string() }),
        );
    }

    if let Some(audio_b64) = body.get("audioBase64").and_then(Value::as_str) {
        if !audio_b64.is_empty() {
            match base64::engine::general_purpose::STANDARD.decode(audio_b64) {
                Ok(bytes) => {
                    if let Err(err) = tokio::fs::write(dir.join("audio.webm"), bytes).await {
                        return json_response(
                            StatusCode::INTERNAL_SERVER_ERROR,
                            json!({ "error": err.to_string() }),
                        );
                    }
                }
                Err(err) => {
                    return json_response(
                        StatusCode::BAD_REQUEST,
                        json!({ "error": format!("invalid audioBase64: {err}") }),
                    )
                }
            }
        }
    }

    for (screenshot_ref, b64) in &to_write {
        match base64::engine::general_purpose::STANDARD.decode(b64) {
            Ok(bytes) => {
                if let Err(err) = tokio::fs::write(dir.join(screenshot_ref), bytes).await {
                    return json_response(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        json!({ "error": err.to_string() }),
                    );
                }
            }
            Err(err) => {
                return json_response(
                    StatusCode::BAD_REQUEST,
                    json!({ "error": format!("invalid screenshot {screenshot_ref}: {err}") }),
                )
            }
        }
    }

    json_response(
        StatusCode::OK,
        json!({ "dir": dir.to_string_lossy(), "sessionId": session_id }),
    )
}

/// `POST /transcribe` — real routing to whichever transcription engine is
/// ready lands in #55; #54 only owns the session-id validation (mirroring
/// the traversal guard) and the frozen `501` stub response.
pub async fn post_transcribe(State(_state): State<AppState>, req: Request) -> Response {
    let body = match read_json_body(req.into_body()).await {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let session_id = body.get("sessionId").and_then(Value::as_str).unwrap_or("");
    if session_id.is_empty() {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({ "error": "sessionId required" }),
        );
    }
    if !security::is_valid_session_id(session_id) {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({ "error": "invalid sessionId" }),
        );
    }
    json_response(
        StatusCode::NOT_IMPLEMENTED,
        json!({ "error": "transcription not implemented yet (see #55)" }),
    )
}

/// `POST /streaming-token` — Pro cloud relay is #60; always `501` here.
pub async fn post_streaming_token(State(_state): State<AppState>, req: Request) -> Response {
    if let Err(resp) = read_json_body(req.into_body()).await {
        return resp;
    }
    json_response(
        StatusCode::NOT_IMPLEMENTED,
        json!({ "error": "streaming token not implemented yet (see #60)" }),
    )
}

/// `POST /issue` — local `gh` issue filing is #56; #54 validates the
/// session id (it will eventually be used to read the saved artifact) and
/// returns the frozen `501` stub.
pub async fn post_issue(State(state): State<AppState>, req: Request) -> Response {
    if !state.config.issue_mode {
        return json_response(
            StatusCode::FORBIDDEN,
            json!({ "error": "issue mode disabled" }),
        );
    }
    let body = match read_json_body(req.into_body()).await {
        Ok(v) => v,
        Err(resp) => return resp,
    };
    let session_id = body.get("sessionId").and_then(Value::as_str).unwrap_or("");
    if session_id.is_empty() {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({ "error": "sessionId required" }),
        );
    }
    if !security::is_valid_session_id(session_id) {
        return json_response(
            StatusCode::BAD_REQUEST,
            json!({ "error": "invalid sessionId" }),
        );
    }
    json_response(
        StatusCode::NOT_IMPLEMENTED,
        json!({ "error": "gh issue filing not implemented yet (see #56)" }),
    )
}
