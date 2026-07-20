//! axum middleware layer replicating `server/github-issue-service.mjs` request
//! dispatch order:
//!
//! 1. Compute CORS headers from the `Origin` request header.
//! 2. `GET /health` short-circuits BEFORE the CSRF/auth gate — token valid or
//!    unset → full payload, else degraded `{ ok: true }` only. `originAllowed`
//!    is derived from the `?origin=` query param (extension contract), NOT the
//!    Origin header (CORS).
//! 3. CSRF guard: Origin header present and not allowlisted → 403 (fires before
//!    the OPTIONS branch, so disallowed origins cannot even preflight).
//! 4. Optional shared-secret auth: token configured and non-OPTIONS request
//!    without a valid `Authorization: Bearer <token>` OR
//!    `x-bugtoprompt-token: <token>` → 401 (constant-time compare).
//! 5. OPTIONS → 204 with the CORS headers.
//! 6. Pass to the router.
//!
//! This differs from a stock `tower_http::cors::CorsLayer` because the frozen
//! contract requires `/health` to bypass CSRF/auth and the degraded-payload
//! behavior is not expressible by tower's layer.

use std::collections::HashMap;

use axum::extract::{Request, State};
use axum::http::header::{self, HeaderMap, HeaderValue};
use axum::http::StatusCode;
use axum::middleware::Next;
use axum::response::{IntoResponse, Json, Response};
use serde_json::json;

use crate::preflight::build_health_payload;
use crate::security::{is_origin_allowed, timing_safe_token_equal};
use crate::state::AppState;

const CORS_ALLOW_METHODS: &str = "GET, POST, OPTIONS";
const CORS_ALLOW_HEADERS: &str = "Content-Type, Authorization";
const CORS_MAX_AGE: &str = "86400";

pub async fn cors_csrf_auth(State(state): State<AppState>, req: Request, next: Next) -> Response {
    let origin = req
        .headers()
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok());

    let cors = cors_headers_for(origin, &state.config.allowed_origins);

    // /health answers before the CORS/auth gates so any local caller can probe
    // readiness, but unauthenticated callers only get the minimal liveness
    // response when a token is configured.
    if req.method() == "GET" && req.uri().path() == "/health" {
        let origin_allowed =
            origin_allowed_from_query(req.uri().query(), &state.config.allowed_origins);
        let valid_token = presents_valid_token(req.headers(), state.config.token.as_deref());

        let (status, body) = if valid_token {
            let gh_state = state.gh_state.read().published();
            let transcription_state = state.transcription_state.read().wire();
            (
                StatusCode::OK,
                build_health_payload(
                    state.config.issue_mode,
                    state.config.targets.len(),
                    gh_state,
                    transcription_state,
                    origin_allowed,
                    env!("CARGO_PKG_VERSION"),
                ),
            )
        } else {
            (
                StatusCode::OK,
                json!({ "ok": true, "version": env!("CARGO_PKG_VERSION") }),
            )
        };

        return with_cors((status, Json(body)).into_response(), &cors);
    }

    // CSRF guard: a browser request from a disallowed Origin is rejected
    // outright (a forged cross-site POST still executes server-side even if CORS
    // hides the response, so we must refuse it, not just omit the ACAO header).
    if let Some(origin) = origin {
        if !is_origin_allowed(Some(origin), &state.config.allowed_origins) {
            return with_cors(
                (
                    StatusCode::FORBIDDEN,
                    Json(json!({ "error": "origin not allowed" })),
                )
                    .into_response(),
                &cors,
            );
        }
    }

    // Optional shared-secret auth: when a token is configured, every
    // non-OPTIONS request must present it.
    if req.method() != "OPTIONS"
        && state.config.token.is_some()
        && !presents_valid_token(req.headers(), state.config.token.as_deref())
    {
        return with_cors(
            (
                StatusCode::UNAUTHORIZED,
                Json(json!({ "error": "unauthorized" })),
            )
                .into_response(),
            &cors,
        );
    }

    if req.method() == "OPTIONS" {
        return with_cors(StatusCode::NO_CONTENT.into_response(), &cors);
    }

    let resp = next.run(req).await;
    with_cors(resp, &cors)
}

fn cors_headers_for(
    origin: Option<&str>,
    allowed: &std::collections::HashSet<String>,
) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static(CORS_ALLOW_METHODS),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static(CORS_ALLOW_HEADERS),
    );
    headers.insert(
        header::ACCESS_CONTROL_MAX_AGE,
        HeaderValue::from_static(CORS_MAX_AGE),
    );
    if let Some(origin) = origin.filter(|o| is_origin_allowed(Some(o), allowed)) {
        if let Ok(v) = HeaderValue::from_str(origin) {
            headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, v);
            headers.insert(header::VARY, HeaderValue::from_static("Origin"));
        }
    }
    headers
}

fn with_cors(resp: Response, cors: &HeaderMap) -> Response {
    let mut resp = resp;
    let headers = resp.headers_mut();
    for (k, v) in cors {
        headers.insert(k, v.clone());
    }
    resp
}

/// True when no token is configured, or the request presented it.
fn presents_valid_token(headers: &HeaderMap, configured: Option<&str>) -> bool {
    let Some(expected) = configured else {
        return true;
    };
    let presented = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|auth| auth.strip_prefix("Bearer "))
        .or_else(|| {
            headers
                .get("x-bugtoprompt-token")
                .and_then(|v| v.to_str().ok())
        });
    timing_safe_token_equal(presented, expected)
}

/// Parse the `?origin=` query param exactly as Node does, using
/// `URLSearchParams.get("origin")`, then check the origin allowlist.
fn origin_allowed_from_query(
    query: Option<&str>,
    allowed: &std::collections::HashSet<String>,
) -> bool {
    let Some(query) = query else {
        return true;
    };
    let mut map: HashMap<String, String> = HashMap::new();
    for (k, v) in url::form_urlencoded::parse(query.as_bytes()) {
        let k: String = k.into_owned();
        let v: String = v.into_owned();
        map.insert(k, v);
    }
    let origin = map.get("origin").map(String::as_str);
    is_origin_allowed(origin, allowed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origin_query_param_matches_node_behavior() {
        let allowed = ["https://gerarposts.com.br".to_string()]
            .into_iter()
            .collect();
        assert!(origin_allowed_from_query(
            Some("origin=https%3A%2F%2Fgerarposts.com.br"),
            &allowed
        ));
        assert!(!origin_allowed_from_query(
            Some("origin=https%3A%2F%2Fevil.com"),
            &allowed
        ));
        assert!(origin_allowed_from_query(
            Some("origin=http%3A%2F%2Flocalhost%3A3000"),
            &allowed
        ));
        assert!(origin_allowed_from_query(Some("other=1"), &allowed));
        assert!(origin_allowed_from_query(None, &allowed));
    }
}
