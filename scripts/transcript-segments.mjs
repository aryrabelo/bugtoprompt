/**
 * Pure transcript-shaping helpers for the batch (`POST /transcribe`) path.
 *
 * AssemblyAI returns word-level timing (`words: [{ text, start, end }]`, ms)
 * for pre-recorded audio. The overlay wants readable `TranscriptSegment[]`
 * (`{ tStartMs, tEndMs, text }`) — one segment per word is unusable, so we
 * group words into sentence-ish chunks. Kept dependency-free and side-effect
 * free so it can be unit-tested in isolation.
 */

/**
 * Group AssemblyAI words into readable, time-spanned transcript segments.
 *
 * A segment is closed when any of these hold after appending a word:
 *   - the word ends a sentence (trailing `.`, `!`, or `?`),
 *   - the silence gap to the next word exceeds `maxGapMs`,
 *   - the running span would exceed `maxSegmentMs`,
 *   - the running text would exceed `maxChars`.
 *
 * @param {Array<{ text?: string, start?: number, end?: number }>} words
 * @param {{ maxGapMs?: number, maxSegmentMs?: number, maxChars?: number }} [opts]
 * @returns {Array<{ tStartMs: number, tEndMs: number, text: string }>}
 */
export function groupWordsIntoSegments(words, opts = {}) {
	const maxGapMs = opts.maxGapMs ?? 700;
	const maxSegmentMs = opts.maxSegmentMs ?? 8000;
	const maxChars = opts.maxChars ?? 220;

	if (!Array.isArray(words)) return [];

	const segments = [];
	/** @type {Array<{ text: string, start: number, end: number }>} */
	let current = [];

	const flush = () => {
		if (current.length === 0) return;
		const text = current
			.map((w) => w.text)
			.join(" ")
			.replace(/\s+/g, " ")
			.trim();
		if (text) {
			segments.push({
				tStartMs: current[0].start,
				tEndMs: current[current.length - 1].end,
				text,
			});
		}
		current = [];
	};

	for (let i = 0; i < words.length; i++) {
		const raw = words[i];
		if (!raw || typeof raw.text !== "string") continue;
		const text = raw.text.trim();
		if (!text) continue;
		const start = Number.isFinite(raw.start) ? raw.start : 0;
		const end = Number.isFinite(raw.end) ? raw.end : start;

		current.push({ text, start, end });

		const spanMs = end - current[0].start;
		const chars = current.reduce((n, w) => n + w.text.length + 1, 0);
		const endsSentence = /[.!?]["')\]]*$/.test(text);

		const next = words[i + 1];
		const nextStart =
			next && Number.isFinite(next.start) ? next.start : undefined;
		const gapMs = nextStart === undefined ? 0 : nextStart - end;

		if (
			endsSentence ||
			gapMs > maxGapMs ||
			spanMs >= maxSegmentMs ||
			chars >= maxChars
		) {
			flush();
		}
	}
	flush();

	return segments;
}

/**
 * Build `TranscriptSegment[]` from a completed AssemblyAI transcript object.
 * Prefers word-level grouping; falls back to a single segment spanning
 * `audio_duration` (seconds) when only `text` is present.
 *
 * @param {{ words?: unknown, text?: string, audio_duration?: number }} transcript
 * @returns {Array<{ tStartMs: number, tEndMs: number, text: string }>}
 */
export function transcriptToSegments(transcript) {
	const t = transcript || {};
	if (Array.isArray(t.words) && t.words.length > 0) {
		const segments = groupWordsIntoSegments(t.words);
		if (segments.length > 0) return segments;
	}
	const text = typeof t.text === "string" ? t.text.trim() : "";
	if (!text) return [];
	const durMs =
		typeof t.audio_duration === "number"
			? Math.round(t.audio_duration * 1000)
			: 0;
	return [{ tStartMs: 0, tEndMs: durMs, text }];
}
