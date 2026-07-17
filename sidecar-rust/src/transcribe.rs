//! Local (no-cloud) transcription engine wiring for `POST /transcribe`.
//!
//! Ports `server/local-transcribe.mjs` + `server/transcript-segments.mjs`:
//! ffmpeg converts the saved `audio.webm` to 16kHz mono WAV, `uvx
//! parakeet-mlx` transcribes it to word-level JSON, a built-in (optionally
//! `BUGTOPROMPT_VOCAB`-overridden) vocabulary corrects domain terms, and the
//! words are grouped into readable time-spanned segments. Every subprocess
//! call is bounded by a timeout so a hung/missing CLI degrades to a clear
//! error instead of hanging the request — readiness itself is probed
//! separately and in the background (see `preflight::detect_local_engine`),
//! this module only runs once that probe already reported the engine ready.

use std::fmt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use rand::distributions::Alphanumeric;
use rand::Rng;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::process::Command;
use tokio::time::timeout;

/// Mirrors `LOCAL_TRANSCRIBE_TIMEOUT_MS` in `server/local-transcribe.mjs`.
pub const LOCAL_TRANSCRIBE_TIMEOUT: Duration = Duration::from_secs(600);

/// `{ tStartMs, tEndMs, text }` — the frozen wire shape of one transcript
/// segment (see `CaptureArtifact["transcript"]` / the epic's HTTP contract).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TranscriptSegment {
    #[serde(rename = "tStartMs")]
    pub t_start_ms: i64,
    #[serde(rename = "tEndMs")]
    pub t_end_ms: i64,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq)]
struct Word {
    text: String,
    start: i64,
    end: i64,
}

#[derive(Debug)]
pub enum TranscribeError {
    Io(std::io::Error),
    Timeout(&'static str),
    CommandFailed { cmd: &'static str, detail: String },
    InvalidOutput(String),
}

impl fmt::Display for TranscribeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            TranscribeError::Io(err) => write!(f, "{err}"),
            TranscribeError::Timeout(cmd) => write!(f, "{cmd} timed out"),
            TranscribeError::CommandFailed { cmd, detail } => {
                if detail.is_empty() {
                    write!(f, "{cmd} exited with a non-zero status")
                } else {
                    write!(f, "{cmd} failed: {detail}")
                }
            }
            TranscribeError::InvalidOutput(msg) => write!(f, "{msg}"),
        }
    }
}

impl std::error::Error for TranscribeError {}

impl From<std::io::Error> for TranscribeError {
    fn from(err: std::io::Error) -> Self {
        TranscribeError::Io(err)
    }
}

// ---------------------------------------------------------------------------
// Vocabulary (mirrors BUILT_IN_VOCAB / loadVocab / applyVocabulary)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct VocabTerm {
    pub text: String,
    #[serde(default)]
    pub aliases: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Vocab {
    pub min_similarity: f64,
    pub terms: Vec<VocabTerm>,
}

#[derive(Debug, Deserialize)]
struct VocabOverride {
    #[serde(rename = "minSimilarity")]
    min_similarity: Option<f64>,
    #[serde(default)]
    terms: Vec<VocabTerm>,
}

pub fn built_in_vocab() -> Vocab {
    let terms = [
        "issue",
        "deploy",
        "commit",
        "pull request",
        "bug",
        "GerarPosts",
        "BugToPrompt",
    ];
    Vocab {
        min_similarity: 0.72,
        terms: terms
            .into_iter()
            .map(|text| VocabTerm {
                text: text.to_string(),
                aliases: vec![],
            })
            .collect(),
    }
}

/// Merge `over` onto `base` by term text: an override entry with a matching
/// `text` replaces the base entry in place, a new `text` is appended —
/// mirrors `mergeVocab`'s `Map`-based merge order.
fn merge_vocab(base: &Vocab, over: VocabOverride) -> Vocab {
    let min_similarity = over.min_similarity.unwrap_or(base.min_similarity);
    let mut terms = base.terms.clone();
    for term in over.terms {
        if term.text.is_empty() {
            continue;
        }
        if let Some(existing) = terms.iter_mut().find(|t| t.text == term.text) {
            *existing = term;
        } else {
            terms.push(term);
        }
    }
    Vocab {
        min_similarity,
        terms,
    }
}

/// Load `BUGTOPROMPT_VOCAB` (a JSON file path) merged over the built-in
/// defaults; falls back to the defaults on any missing/unreadable/malformed
/// file, mirroring `loadVocab`'s try/catch.
pub fn load_vocab() -> Vocab {
    let base = built_in_vocab();
    let Ok(path) = std::env::var("BUGTOPROMPT_VOCAB") else {
        return base;
    };
    if path.is_empty() {
        return base;
    }
    let loaded = std::fs::read_to_string(&path)
        .map_err(|err| err.to_string())
        .and_then(|raw| serde_json::from_str::<VocabOverride>(&raw).map_err(|err| err.to_string()));
    match loaded {
        Ok(over) => merge_vocab(&base, over),
        Err(err) => {
            tracing::error!("[transcribe] failed to load vocab {path}: {err}");
            base
        }
    }
}

pub fn levenshtein_distance(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let (m, n) = (a.len(), b.len());
    if m == 0 {
        return n;
    }
    if n == 0 {
        return m;
    }
    let mut prev: Vec<usize> = (0..=n).collect();
    let mut curr = vec![0usize; n + 1];
    for i in 1..=m {
        curr[0] = i;
        for j in 1..=n {
            curr[j] = (prev[j] + 1)
                .min(curr[j - 1] + 1)
                .min(prev[j - 1] + usize::from(a[i - 1] != b[j - 1]));
        }
        std::mem::swap(&mut prev, &mut curr);
    }
    prev[n]
}

pub fn similarity(a: &str, b: &str) -> f64 {
    let max_len = a.chars().count().max(b.chars().count());
    if max_len == 0 {
        return 1.0;
    }
    1.0 - (levenshtein_distance(a, b) as f64) / (max_len as f64)
}

/// Lowercase + strip everything but `\w\s` (ASCII word chars, matching JS's
/// non-unicode `\w`) + collapse whitespace — mirrors `normalize()`.
fn normalize(s: &str) -> String {
    let lower = s.to_lowercase();
    let filtered: String = lower
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || c.is_whitespace())
        .collect();
    filtered.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Trailing run of non-word, non-space characters — mirrors `/[^\w\s]+$/`.
fn trailing_punctuation(word: &str) -> String {
    let chars: Vec<char> = word.chars().collect();
    let mut end = chars.len();
    while end > 0 {
        let c = chars[end - 1];
        if c.is_ascii_alphanumeric() || c == '_' || c.is_whitespace() {
            break;
        }
        end -= 1;
    }
    chars[end..].iter().collect()
}

/// Post-correct transcribed words using the vocabulary: matches each term
/// (and its aliases) against single- and multi-word windows, longest alias
/// first, replacing a window with the term text when normalized Levenshtein
/// similarity clears the threshold. Mirrors `applyVocabulary`.
fn apply_vocabulary(words: &[Word], vocab: &Vocab) -> Vec<Word> {
    struct Matcher<'a> {
        text: &'a str,
        alias: &'a str,
    }
    let mut matchers: Vec<Matcher> = Vec::new();
    for term in &vocab.terms {
        matchers.push(Matcher {
            text: &term.text,
            alias: &term.text,
        });
        for alias in &term.aliases {
            if !alias.is_empty() {
                matchers.push(Matcher {
                    text: &term.text,
                    alias,
                });
            }
        }
    }
    matchers.sort_by_key(|m| std::cmp::Reverse(m.alias.split_whitespace().count()));

    let mut result = Vec::new();
    let mut i = 0;
    while i < words.len() {
        let mut replaced = false;
        for m in &matchers {
            let alias_words: Vec<&str> = m.alias.split_whitespace().collect();
            if alias_words.is_empty() || i + alias_words.len() > words.len() {
                continue;
            }
            let window = &words[i..i + alias_words.len()];
            let window_text = window
                .iter()
                .map(|w| w.text.as_str())
                .collect::<Vec<_>>()
                .join(" ");
            if similarity(&normalize(&window_text), &normalize(m.alias)) >= vocab.min_similarity {
                let trailing_punct = trailing_punctuation(&window[window.len() - 1].text);
                result.push(Word {
                    text: format!("{}{trailing_punct}", m.text),
                    start: window[0].start,
                    end: window[window.len() - 1].end,
                });
                i += alias_words.len();
                replaced = true;
                break;
            }
        }
        if !replaced {
            result.push(words[i].clone());
            i += 1;
        }
    }
    result
}

// ---------------------------------------------------------------------------
// parakeet-mlx JSON -> word timings (mirrors tokensToWords/parakeetJsonToWords)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct ParakeetToken {
    text: String,
    start: Option<f64>,
    end: Option<f64>,
}

#[derive(Debug, Default, Deserialize)]
struct ParakeetSentence {
    #[serde(default)]
    tokens: Vec<ParakeetToken>,
}

#[derive(Debug, Default, Deserialize)]
struct ParakeetOutput {
    #[serde(default)]
    sentences: Vec<ParakeetSentence>,
}

/// Reconstruct word-level timings from parakeet-mlx sentence tokens. Tokens
/// use a leading space to mark word boundaries; times are seconds -> ms.
/// Mirrors `tokensToWords`.
fn tokens_to_words(tokens: &[ParakeetToken]) -> Vec<Word> {
    let mut words = Vec::new();
    let mut current_text = String::new();
    let mut current_start = 0.0_f64;
    let mut current_end = 0.0_f64;

    for token in tokens {
        let start_ms = token
            .start
            .filter(|v| v.is_finite())
            .map_or(0.0, |v| v * 1000.0);
        let end_ms = token
            .end
            .filter(|v| v.is_finite())
            .map_or(start_ms, |v| v * 1000.0);

        if let Some(rest) = token.text.strip_prefix(' ') {
            if !current_text.is_empty() {
                words.push(Word {
                    text: std::mem::take(&mut current_text),
                    start: current_start.round() as i64,
                    end: current_end.round() as i64,
                });
            }
            current_text = rest.trim_start().to_string();
            current_start = start_ms;
            current_end = end_ms;
        } else if current_text.is_empty() {
            current_text = token.text.clone();
            current_start = start_ms;
            current_end = end_ms;
        } else {
            current_text.push_str(&token.text);
            current_end = end_ms;
        }
    }

    if !current_text.is_empty() {
        words.push(Word {
            text: current_text,
            start: current_start.round() as i64,
            end: current_end.round() as i64,
        });
    }
    words
}

fn parakeet_json_to_words(data: &ParakeetOutput) -> Vec<Word> {
    data.sentences
        .iter()
        .flat_map(|s| tokens_to_words(&s.tokens))
        .collect()
}

// ---------------------------------------------------------------------------
// Word timings -> readable segments (mirrors groupWordsIntoSegments)
// ---------------------------------------------------------------------------

struct SegmentOptions {
    max_gap_ms: i64,
    max_segment_ms: i64,
    max_chars: usize,
}

impl Default for SegmentOptions {
    fn default() -> Self {
        Self {
            max_gap_ms: 700,
            max_segment_ms: 8000,
            max_chars: 220,
        }
    }
}

/// A segment ends are the started sentence [.!?], too long a silence gap to
/// the next word, too long a span, or too many characters — mirrors
/// `groupWordsIntoSegments`.
fn ends_sentence(text: &str) -> bool {
    text.trim_end_matches(['"', '\'', ')', ']'])
        .ends_with(['.', '!', '?'])
}

fn flush_segment(current: &mut Vec<Word>, segments: &mut Vec<TranscriptSegment>) {
    if current.is_empty() {
        return;
    }
    let joined = current
        .iter()
        .map(|w| w.text.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    let text = joined.split_whitespace().collect::<Vec<_>>().join(" ");
    if !text.is_empty() {
        segments.push(TranscriptSegment {
            t_start_ms: current[0].start,
            t_end_ms: current[current.len() - 1].end,
            text,
        });
    }
    current.clear();
}

fn group_words_into_segments(words: &[Word], opts: &SegmentOptions) -> Vec<TranscriptSegment> {
    let mut segments = Vec::new();
    let mut current: Vec<Word> = Vec::new();

    for (i, raw) in words.iter().enumerate() {
        let text = raw.text.trim();
        if text.is_empty() {
            continue;
        }
        current.push(Word {
            text: text.to_string(),
            start: raw.start,
            end: raw.end,
        });

        let span_ms = raw.end - current[0].start;
        let chars: usize = current.iter().map(|w| w.text.chars().count() + 1).sum();
        let gap_ms = words.get(i + 1).map_or(0, |next| next.start - raw.end);

        if ends_sentence(text)
            || gap_ms > opts.max_gap_ms
            || span_ms >= opts.max_segment_ms
            || chars >= opts.max_chars
        {
            flush_segment(&mut current, &mut segments);
        }
    }
    flush_segment(&mut current, &mut segments);
    segments
}

// ---------------------------------------------------------------------------
// Subprocess boundary: ffmpeg + uvx parakeet-mlx
// ---------------------------------------------------------------------------

struct TempDirGuard(PathBuf);

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

async fn make_temp_dir() -> Result<PathBuf, TranscribeError> {
    let suffix: String = rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(12)
        .map(char::from)
        .collect();
    let dir = std::env::temp_dir().join(format!("bugtoprompt-local-{suffix}"));
    tokio::fs::create_dir_all(&dir).await?;
    Ok(dir)
}

/// Run one CLI, bounded by `bound` — mirrors the `execFileAsync(..., {
/// timeout })` guard in `localTranscribe`: a hung process is killed
/// (`kill_on_drop`), never left to block the request indefinitely.
/// `extra_path` is test-only: replaces `PATH` entirely so tests can stub
/// the CLI deterministically (mirrors `service-e2e.test.mjs`'s
/// fake-binary-on-PATH pattern) instead of requiring the real model in CI or
/// depending on what happens to be installed on the host.
async fn run_command(
    cmd: &'static str,
    args: &[&str],
    bound: Duration,
    extra_path: Option<&str>,
) -> Result<(), TranscribeError> {
    let mut command = Command::new(cmd);
    command.args(args).kill_on_drop(true);
    // Test-only: REPLACE PATH entirely (not prepend) so a deliberately
    // empty/minimal override is deterministic regardless of what happens to
    // be installed on the host running the test.
    if let Some(extra) = extra_path {
        command.env("PATH", extra);
    }
    let output = match timeout(bound, command.output()).await {
        Err(_) => return Err(TranscribeError::Timeout(cmd)),
        Ok(res) => res?,
    };
    if output.status.success() {
        Ok(())
    } else {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(TranscribeError::CommandFailed { cmd, detail })
    }
}

/// Transcribe `audio_path` (a saved session's `audio.webm`) locally via
/// ffmpeg + `uvx parakeet-mlx`, mirroring `localTranscribe`. Never called
/// unless the background probe already reported the engine ready — a
/// mid-flight failure (binary removed, model fetch broken) still surfaces as
/// a plain `Err`, never a panic, so the handler can answer `502` instead of
/// crashing the process.
pub async fn local_transcribe(
    audio_path: &Path,
    timeout_dur: Duration,
    vocab: &Vocab,
    extra_path: Option<&str>,
) -> Result<Vec<TranscriptSegment>, TranscribeError> {
    let tmp_dir = make_temp_dir().await?;
    let _guard = TempDirGuard(tmp_dir.clone());

    let wav_path = tmp_dir.join("audio.wav");
    let audio_path_str = audio_path
        .to_str()
        .ok_or_else(|| TranscribeError::InvalidOutput("audio path is not valid UTF-8".into()))?;
    let wav_path_str = wav_path
        .to_str()
        .ok_or_else(|| TranscribeError::InvalidOutput("temp wav path is not valid UTF-8".into()))?;
    let tmp_dir_str = tmp_dir
        .to_str()
        .ok_or_else(|| TranscribeError::InvalidOutput("temp dir path is not valid UTF-8".into()))?;

    run_command(
        "ffmpeg",
        &[
            "-y",
            "-i",
            audio_path_str,
            "-ar",
            "16000",
            "-ac",
            "1",
            "-c:a",
            "pcm_s16le",
            wav_path_str,
        ],
        timeout_dur,
        extra_path,
    )
    .await?;

    run_command(
        "uvx",
        &[
            "parakeet-mlx",
            wav_path_str,
            "--output-format",
            "json",
            "--output-dir",
            tmp_dir_str,
        ],
        timeout_dur,
        extra_path,
    )
    .await?;

    let json_path = tmp_dir.join("audio.json");
    let raw = tokio::fs::read_to_string(&json_path).await.map_err(|err| {
        TranscribeError::InvalidOutput(format!("failed to read parakeet output: {err}"))
    })?;
    let data: ParakeetOutput = serde_json::from_str(&raw).map_err(|err| {
        TranscribeError::InvalidOutput(format!("failed to parse parakeet output: {err}"))
    })?;

    let words = parakeet_json_to_words(&data);
    let corrected = apply_vocabulary(&words, vocab);
    Ok(group_words_into_segments(
        &corrected,
        &SegmentOptions::default(),
    ))
}

/// Persist the batch transcript back into the session's `artifact.json`,
/// mirroring `persistTranscript`. Best-effort: any read/parse/write failure
/// is logged and swallowed — a persistence miss must never fail a request
/// that already has a good transcript to return.
pub async fn persist_transcript(session_dir: &Path, transcript: &[TranscriptSegment]) {
    let file = session_dir.join("artifact.json");
    let raw = match tokio::fs::read_to_string(&file).await {
        Ok(raw) => raw,
        Err(_) => return,
    };
    let Ok(mut artifact) = serde_json::from_str::<Value>(&raw) else {
        return;
    };
    let Ok(transcript_value) = serde_json::to_value(transcript) else {
        return;
    };
    artifact["transcript"] = transcript_value;
    artifact["transcriptionMode"] = Value::String("batch-fallback".to_string());
    match serde_json::to_string_pretty(&artifact) {
        Ok(pretty) => {
            if let Err(err) = tokio::fs::write(&file, pretty).await {
                tracing::error!("[transcribe] persist failed: {err}");
            }
        }
        Err(err) => tracing::error!("[transcribe] persist failed: {err}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn word(text: &str, start: i64, end: i64) -> Word {
        Word {
            text: text.to_string(),
            start,
            end,
        }
    }

    fn token(text: &str, start: f64, end: f64) -> ParakeetToken {
        ParakeetToken {
            text: text.to_string(),
            start: Some(start),
            end: Some(end),
        }
    }

    #[test]
    fn tokens_to_words_reconstructs_words_from_subword_tokens() {
        let tokens = vec![
            token(" H", 0.0, 0.08),
            token("ello", 0.08, 0.16),
            token(" is", 0.32, 0.4),
            token("s", 0.4, 0.48),
            token("ue", 0.48, 0.56),
            token(" de", 0.72, 0.88),
            token("plo", 0.88, 0.96),
            token("y", 0.96, 1.12),
            token(" com", 1.12, 1.2),
            token("mit", 1.2, 1.36),
            token(".", 1.36, 1.44),
        ];
        assert_eq!(
            tokens_to_words(&tokens),
            vec![
                word("Hello", 0, 160),
                word("issue", 320, 560),
                word("deploy", 720, 1120),
                word("commit.", 1120, 1440),
            ]
        );
    }

    #[test]
    fn parakeet_json_to_words_flattens_all_sentences_into_ms() {
        let data = ParakeetOutput {
            sentences: vec![
                ParakeetSentence {
                    tokens: vec![token(" One", 0.0, 0.5), token(".", 0.5, 0.6)],
                },
                ParakeetSentence {
                    tokens: vec![token(" Two", 1.0, 1.5), token(".", 1.5, 1.6)],
                },
            ],
        };
        assert_eq!(
            parakeet_json_to_words(&data),
            vec![word("One.", 0, 600), word("Two.", 1000, 1600)]
        );
    }

    #[test]
    fn parakeet_json_to_words_empty_input_is_empty() {
        assert_eq!(parakeet_json_to_words(&ParakeetOutput::default()), vec![]);
    }

    #[test]
    fn levenshtein_and_similarity_match_the_node_reference() {
        assert_eq!(levenshtein_distance("kitten", "sitting"), 3);
        assert_eq!(levenshtein_distance("", "abc"), 3);
        assert_eq!(levenshtein_distance("abc", "abc"), 0);
        assert_eq!(similarity("abc", "abc"), 1.0);
        assert_eq!(similarity("abc", ""), 0.0);
        assert!((similarity("issue", "issues") - 0.833).abs() < 0.01);
    }

    #[test]
    fn apply_vocabulary_corrects_a_phrase_alias() {
        let words = vec![
            word("e", 0, 100),
            word("sui", 120, 300),
            word("deploy", 400, 800),
        ];
        let vocab = Vocab {
            min_similarity: 0.72,
            terms: vec![VocabTerm {
                text: "issue".to_string(),
                aliases: vec!["e sui".to_string()],
            }],
        };
        assert_eq!(
            apply_vocabulary(&words, &vocab),
            vec![word("issue", 0, 300), word("deploy", 400, 800)]
        );
    }

    #[test]
    fn apply_vocabulary_corrects_a_near_match_single_word() {
        let words = vec![word("issues", 0, 100), word("now", 120, 200)];
        let vocab = Vocab {
            min_similarity: 0.72,
            terms: vec![VocabTerm {
                text: "issue".to_string(),
                aliases: vec![],
            }],
        };
        assert_eq!(
            apply_vocabulary(&words, &vocab),
            vec![word("issue", 0, 100), word("now", 120, 200)]
        );
    }

    #[test]
    fn apply_vocabulary_preserves_words_that_do_not_match() {
        let words = vec![word("hello", 0, 100)];
        assert_eq!(apply_vocabulary(&words, &built_in_vocab()), words);
    }

    #[test]
    fn apply_vocabulary_prefers_longer_alias_matches() {
        let words = vec![word("pull", 0, 100), word("request", 120, 300)];
        assert_eq!(
            apply_vocabulary(&words, &built_in_vocab()),
            vec![word("pull request", 0, 300)]
        );
    }

    #[test]
    fn group_words_into_segments_flushes_on_sentence_end() {
        let words = vec![word("Hello", 0, 500), word("world.", 600, 1200)];
        assert_eq!(
            group_words_into_segments(&words, &SegmentOptions::default()),
            vec![TranscriptSegment {
                t_start_ms: 0,
                t_end_ms: 1200,
                text: "Hello world.".to_string(),
            }]
        );
    }

    #[test]
    fn group_words_into_segments_flushes_on_a_long_silence_gap() {
        let words = vec![word("Hello", 0, 500), word("there", 5000, 5300)];
        let segments = group_words_into_segments(&words, &SegmentOptions::default());
        assert_eq!(segments.len(), 2);
        assert_eq!(segments[0].text, "Hello");
        assert_eq!(segments[1].text, "there");
    }

    #[test]
    fn merge_vocab_replaces_matching_text_and_appends_new_terms() {
        let base = built_in_vocab();
        let over = VocabOverride {
            min_similarity: Some(0.85),
            terms: vec![
                VocabTerm {
                    text: "GerarPosts".to_string(),
                    aliases: vec!["gerar posts".to_string()],
                },
                VocabTerm {
                    text: "custom".to_string(),
                    aliases: vec![],
                },
            ],
        };
        let merged = merge_vocab(&base, over);
        assert_eq!(merged.min_similarity, 0.85);
        assert!(merged.terms.iter().any(|t| t.text == "custom"));
        assert!(merged.terms.iter().any(|t| t.text == "issue"));
        let gerar = merged
            .terms
            .iter()
            .find(|t| t.text == "GerarPosts")
            .unwrap();
        assert!(gerar.aliases.contains(&"gerar posts".to_string()));
    }

    #[test]
    fn load_vocab_returns_built_in_defaults_when_unset() {
        std::env::remove_var("BUGTOPROMPT_VOCAB");
        assert_eq!(load_vocab(), built_in_vocab());
    }

    /// Writes fake `ffmpeg`/`uvx` executable shell scripts into a fresh temp
    /// bin dir (mirrors `service-e2e.test.mjs`'s beforeAll fixture) so the
    /// real subprocess boundary is exercised without the real model.
    /// Minimal, deterministic test PATH: the fake bin dir plus just enough
    /// of the real system dirs for the fake scripts' own shell builtins
    /// (`cat`, etc) to work — deliberately excludes /opt/homebrew/bin (or
    /// wherever the host's real `uvx`/`ffmpeg` might live) so the test never
    /// depends on what happens to be installed on the machine running it.
    fn test_path(bin_dir: &Path) -> String {
        format!("{}:/bin:/usr/bin", bin_dir.display())
    }

    fn write_fake_engine(bin_dir: &Path, parakeet_json: &str) {
        std::fs::write(bin_dir.join("ffmpeg"), "#!/bin/sh\nexit 0\n").unwrap();
        std::fs::write(
            bin_dir.join("uvx"),
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
                    bin_dir.join(name),
                    std::fs::Permissions::from_mode(0o755),
                )
                .unwrap();
            }
        }
    }

    #[tokio::test]
    async fn local_transcribe_runs_the_stubbed_engine_and_maps_to_the_segment_contract() {
        let bin_dir = tempfile::tempdir().unwrap();
        let parakeet_json = serde_json::json!({
            "sentences": [{
                "tokens": [
                    { "text": " Hello", "start": 0.0, "end": 0.5 },
                    { "text": " world.", "start": 0.6, "end": 1.2 },
                ]
            }]
        })
        .to_string();
        write_fake_engine(bin_dir.path(), &parakeet_json);

        let audio_dir = tempfile::tempdir().unwrap();
        let audio_path = audio_dir.path().join("audio.webm");
        std::fs::write(&audio_path, b"fake-webm-bytes").unwrap();

        let segments = local_transcribe(
            &audio_path,
            Duration::from_secs(5),
            &built_in_vocab(),
            Some(test_path(bin_dir.path()).as_str()),
        )
        .await
        .unwrap();

        assert_eq!(
            segments,
            vec![TranscriptSegment {
                t_start_ms: 0,
                t_end_ms: 1200,
                text: "Hello world.".to_string(),
            }]
        );
    }

    #[tokio::test]
    async fn local_transcribe_degrades_to_a_clear_error_when_the_engine_is_missing() {
        let empty_bin_dir = tempfile::tempdir().unwrap();
        let audio_dir = tempfile::tempdir().unwrap();
        let audio_path = audio_dir.path().join("audio.webm");
        std::fs::write(&audio_path, b"fake-webm-bytes").unwrap();

        // An empty PATH override (no fallback to the real PATH) guarantees
        // `ffmpeg`/`uvx` cannot be found, mirroring "uvx missing" — the
        // process must return an Err, never panic.
        let err = local_transcribe(
            &audio_path,
            Duration::from_secs(5),
            &built_in_vocab(),
            Some(test_path(empty_bin_dir.path()).as_str()),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, TranscribeError::Io(_)));
    }

    #[tokio::test]
    async fn persist_transcript_writes_transcript_and_batch_fallback_mode() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("artifact.json"),
            serde_json::json!({ "sessionId": "cap_test" }).to_string(),
        )
        .unwrap();
        let transcript = vec![TranscriptSegment {
            t_start_ms: 0,
            t_end_ms: 100,
            text: "hi".to_string(),
        }];

        persist_transcript(dir.path(), &transcript).await;

        let raw = tokio::fs::read_to_string(dir.path().join("artifact.json"))
            .await
            .unwrap();
        let artifact: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(artifact["transcriptionMode"], "batch-fallback");
        assert_eq!(
            artifact["transcript"],
            serde_json::json!([{ "tStartMs": 0, "tEndMs": 100, "text": "hi" }])
        );
    }

    #[tokio::test]
    async fn persist_transcript_is_a_silent_no_op_when_artifact_json_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        // No artifact.json written — must not panic or create one.
        persist_transcript(
            dir.path(),
            &[TranscriptSegment {
                t_start_ms: 0,
                t_end_ms: 1,
                text: "x".to_string(),
            }],
        )
        .await;
        assert!(!dir.path().join("artifact.json").exists());
    }
}
