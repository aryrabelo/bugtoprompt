//! Security helpers mirroring `server/service-security.mjs`: session-id /
//! screenshot-ref path-traversal guards, origin allowlisting, and a
//! constant-time shared-secret compare. Pure functions, unit-tested directly.

use std::collections::HashSet;

use hmac::{Hmac, Mac};
use sha2::Sha256;
use subtle::ConstantTimeEq;

type HmacSha256 = Hmac<Sha256>;

/// Client session ids are minted as `cap_<uuid>`. Reject anything else BEFORE
/// it is used in a filesystem path — the pattern structurally excludes `.`,
/// `/`, and `\`, so a valid id can never traverse.
pub fn is_valid_session_id(s: &str) -> bool {
    match s.strip_prefix("cap_") {
        Some(rest) if !rest.is_empty() => {
            rest.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        }
        _ => false,
    }
}

/// A persisted screenshot filename: `snap-NNNN.jpg` with four or more digits,
/// no leading zero once past four digits (mirrors
/// `/^snap-(?:[0-9]{4}|[1-9][0-9]{4,})\.jpg$/`). No path separators possible.
pub fn is_valid_screenshot_ref(s: &str) -> bool {
    let Some(rest) = s.strip_prefix("snap-") else {
        return false;
    };
    let Some(digits) = rest.strip_suffix(".jpg") else {
        return false;
    };
    match digits.len() {
        4 => digits.bytes().all(|b| b.is_ascii_digit()),
        n if n > 4 => {
            let mut bytes = digits.bytes();
            let first = bytes.next().unwrap();
            first.is_ascii_digit() && first != b'0' && bytes.all(|b| b.is_ascii_digit())
        }
        _ => false,
    }
}

/// Parse `BUGTOPROMPT_ALLOWED_ORIGINS` (comma-separated exact origins).
pub fn parse_allowed_origins(raw: &str) -> HashSet<String> {
    raw.split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}

/// A browser Origin is allowed when it is a localhost/127.0.0.1 dev origin
/// (any port, http/https), a Tauri webview origin, or explicitly allowlisted.
/// `None` (non-browser clients send no Origin header) is always allowed.
pub fn is_origin_allowed(origin: Option<&str>, allow_set: &HashSet<String>) -> bool {
    let Some(origin) = origin else {
        return true;
    };
    if allow_set.contains(origin) {
        return true;
    }
    if origin == "tauri://localhost" || origin == "https://tauri.localhost" {
        return true;
    }
    match url::Url::parse(origin) {
        Ok(u) => matches!(u.host_str(), Some("localhost") | Some("127.0.0.1")),
        Err(_) => false,
    }
}

/// Constant-time shared-secret compare (double-HMAC pattern, mirrors
/// `timingSafeTokenEqual`): both values are HMAC-SHA256'd under a fresh
/// random per-call key, so the final compare is always over fixed-length
/// digests — no early exit, no length leak. Fails closed when nothing was
/// presented.
pub fn timing_safe_token_equal(presented: Option<&str>, expected: &str) -> bool {
    let Some(presented) = presented else {
        return false;
    };
    let mut key = [0u8; 32];
    rand::Rng::fill(&mut rand::thread_rng(), &mut key);
    let a = hmac_digest(&key, presented.as_bytes());
    let b = hmac_digest(&key, expected.as_bytes());
    a.ct_eq(&b).into()
}

fn hmac_digest(key: &[u8], data: &[u8]) -> [u8; 32] {
    let mut mac = HmacSha256::new_from_slice(key).expect("hmac accepts any key length");
    mac.update(data);
    let mut out = [0u8; 32];
    out.copy_from_slice(&mac.finalize().into_bytes());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_id_accepts_the_client_shape() {
        assert!(is_valid_session_id("cap_ABC-123"));
        assert!(is_valid_session_id("cap_a"));
    }

    #[test]
    fn session_id_rejects_traversal_and_malformed_input() {
        assert!(!is_valid_session_id("../etc/passwd"));
        assert!(!is_valid_session_id("cap_../secret"));
        assert!(!is_valid_session_id("cap_foo/bar"));
        assert!(!is_valid_session_id("cap_foo\\bar"));
        assert!(!is_valid_session_id("cap_"));
        assert!(!is_valid_session_id(""));
        assert!(!is_valid_session_id("nope"));
    }

    #[test]
    fn screenshot_ref_accepts_four_plus_digits() {
        assert!(is_valid_screenshot_ref("snap-0000.jpg"));
        assert!(is_valid_screenshot_ref("snap-9999.jpg"));
        assert!(is_valid_screenshot_ref("snap-10000.jpg"));
    }

    #[test]
    fn screenshot_ref_rejects_traversal_and_bad_shapes() {
        assert!(!is_valid_screenshot_ref("../snap-0001.jpg"));
        assert!(!is_valid_screenshot_ref("snap-1.jpg"));
        assert!(!is_valid_screenshot_ref("snap-0001.png"));
        assert!(!is_valid_screenshot_ref("snap-01000.jpg")); // leading zero past 4 digits
        assert!(!is_valid_screenshot_ref("dir/snap-0001.jpg"));
    }

    #[test]
    fn origin_allowlist_trusts_loopback_and_tauri() {
        let empty = HashSet::new();
        assert!(is_origin_allowed(None, &empty));
        assert!(is_origin_allowed(Some("http://localhost:5173"), &empty));
        assert!(is_origin_allowed(Some("https://127.0.0.1:9999"), &empty));
        assert!(is_origin_allowed(Some("tauri://localhost"), &empty));
        assert!(!is_origin_allowed(Some("https://evil.example.com"), &empty));
    }

    #[test]
    fn origin_allowlist_trusts_configured_extras() {
        let mut set = HashSet::new();
        set.insert("https://gerarposts.com.br".to_string());
        assert!(is_origin_allowed(Some("https://gerarposts.com.br"), &set));
        assert!(!is_origin_allowed(Some("https://other.example.com"), &set));
    }

    #[test]
    fn token_compare_matches_and_rejects() {
        assert!(timing_safe_token_equal(Some("secret"), "secret"));
        assert!(!timing_safe_token_equal(Some("wrong"), "secret"));
        assert!(!timing_safe_token_equal(None, "secret"));
        assert!(!timing_safe_token_equal(Some(""), "secret"));
    }
}
