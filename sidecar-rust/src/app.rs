use axum::routing::{get, post};
use axum::Router;
use tower_http::trace::TraceLayer;

use crate::handlers::{
    get_config, get_targets, not_found, post_artifact, post_issue, post_streaming_token,
    post_transcribe,
};
use crate::mw::cors_csrf_auth;
use crate::state::AppState;

pub fn build_app(state: AppState) -> Router {
    Router::new()
        .route("/bugtoprompt/config", get(get_config))
        .route("/targets", get(get_targets))
        .route("/artifact", post(post_artifact))
        .route("/transcribe", post(post_transcribe))
        .route("/streaming-token", post(post_streaming_token))
        .route("/issue", post(post_issue))
        .fallback(not_found)
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            cors_csrf_auth,
        ))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    fn test_state() -> AppState {
        AppState::new(Config::load())
    }

    #[tokio::test]
    async fn unmatched_route_returns_not_found_json() {
        let app = build_app(test_state());
        let resp = app
            .oneshot(Request::builder().uri("/nope").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(resp.status(), 404);
    }
}
