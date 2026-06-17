import { describe, expect, it } from "vitest";
import {
	groupWordsIntoSegments,
	transcriptToSegments,
} from "./transcript-segments.mjs";

const w = (text, start, end) => ({ text, start, end });

describe("groupWordsIntoSegments", () => {
	it("returns [] for empty or invalid input", () => {
		expect(groupWordsIntoSegments([])).toEqual([]);
		expect(groupWordsIntoSegments(undefined)).toEqual([]);
		expect(groupWordsIntoSegments(null)).toEqual([]);
	});

	it("groups contiguous words into one segment with the full span", () => {
		const segments = groupWordsIntoSegments([
			w("the", 0, 100),
			w("login", 120, 300),
			w("button", 320, 500),
		]);
		expect(segments).toEqual([
			{ tStartMs: 0, tEndMs: 500, text: "the login button" },
		]);
	});

	it("splits on sentence-ending punctuation", () => {
		const segments = groupWordsIntoSegments([
			w("it", 0, 100),
			w("broke.", 120, 300),
			w("then", 320, 500),
			w("nothing", 520, 800),
		]);
		expect(segments).toHaveLength(2);
		expect(segments[0]).toEqual({
			tStartMs: 0,
			tEndMs: 300,
			text: "it broke.",
		});
		expect(segments[1].text).toBe("then nothing");
		expect(segments[1].tStartMs).toBe(320);
		expect(segments[1].tEndMs).toBe(800);
	});

	it("splits on a long silence gap between words", () => {
		const segments = groupWordsIntoSegments(
			[w("hello", 0, 200), w("again", 2000, 2200)],
			{ maxGapMs: 700 },
		);
		expect(segments).toHaveLength(2);
		expect(segments[0].text).toBe("hello");
		expect(segments[1].text).toBe("again");
	});

	it("splits when the running span exceeds maxSegmentMs", () => {
		const segments = groupWordsIntoSegments(
			[
				w("a", 0, 100),
				w("b", 500, 600),
				w("c", 1100, 1200),
				w("d", 1300, 1400),
			],
			{ maxSegmentMs: 1000, maxGapMs: 10000 },
		);
		expect(segments).toHaveLength(2);
		expect(segments[0].text).toBe("a b c");
		expect(segments[1].text).toBe("d");
	});

	it("skips blank/invalid words without crashing", () => {
		const segments = groupWordsIntoSegments([
			w("real", 0, 100),
			{ text: "   ", start: 120, end: 200 },
			{ start: 220, end: 300 },
			w("word", 320, 400),
		]);
		expect(segments).toEqual([{ tStartMs: 0, tEndMs: 400, text: "real word" }]);
	});
});

describe("transcriptToSegments", () => {
	it("prefers word-level grouping when words are present", () => {
		const segments = transcriptToSegments({
			text: "hello world.",
			words: [w("hello", 0, 200), w("world.", 220, 500)],
			audio_duration: 1.5,
		});
		expect(segments).toEqual([
			{ tStartMs: 0, tEndMs: 500, text: "hello world." },
		]);
	});

	it("falls back to a single segment from text + audio_duration", () => {
		const segments = transcriptToSegments({
			text: "no word timing here",
			audio_duration: 2.4,
		});
		expect(segments).toEqual([
			{ tStartMs: 0, tEndMs: 2400, text: "no word timing here" },
		]);
	});

	it("returns [] when there is no usable text", () => {
		expect(transcriptToSegments({})).toEqual([]);
		expect(transcriptToSegments({ text: "   " })).toEqual([]);
		expect(transcriptToSegments(null)).toEqual([]);
	});
});
