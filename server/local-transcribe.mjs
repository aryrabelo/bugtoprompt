#!/usr/bin/env node
/**
 * Local (no-cloud) transcription provider for the BugToPrompt sidecar.
 *
 * Uses parakeet-mlx via `uvx` and ffmpeg for audio conversion. The module is
 * dependency-free and injects exec/fs so tests never run the real model.
 */

import { execFile as defaultExecFile } from "node:child_process";
import { readFileSync as defaultReadFileSync } from "node:fs";
import {
	mkdtemp as defaultMkdtemp,
	readFile as defaultReadFile,
	rm as defaultRm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { groupWordsIntoSegments } from "./transcript-segments.mjs";

const execFileAsync = promisify(defaultExecFile);

export const LOCAL_TRANSCRIBE_TIMEOUT_MS = 10 * 60 * 1000;

export const BUILT_IN_VOCAB = {
	minSimilarity: 0.72,
	terms: [
		{ text: "issue", aliases: [], weight: 1 },
		{ text: "deploy", aliases: [], weight: 1 },
		{ text: "commit", aliases: [], weight: 1 },
		{ text: "pull request", aliases: [], weight: 1 },
		{ text: "bug", aliases: [], weight: 1 },
		{ text: "GerarPosts", aliases: [], weight: 1 },
		{ text: "BugToPrompt", aliases: [], weight: 1 },
	],
};

/**
 * Select the active transcription provider from environment + runtime state.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {{ localReady: boolean }} state
 * @returns {"assemblyai" | "local" | "unconfigured"}
 */
export function resolveTranscribeProvider(env, { localReady }) {
	const setting = env.BUGTOPROMPT_TRANSCRIBE || "auto";
	const hasKey =
		typeof env.ASSEMBLYAI_API_KEY === "string" &&
		env.ASSEMBLYAI_API_KEY.length > 0;
	if (setting === "local") return localReady ? "local" : "unconfigured";
	if (setting === "assemblyai") return hasKey ? "assemblyai" : "unconfigured";
	// auto: prefer local, then AssemblyAI key, else unconfigured.
	if (localReady) return "local";
	if (hasKey) return "assemblyai";
	return "unconfigured";
}

function mergeVocab(base, override) {
	const result = {
		minSimilarity: override?.minSimilarity ?? base.minSimilarity,
		terms: [...base.terms],
	};
	const byText = new Map(result.terms.map((t) => [t.text, t]));
	for (const term of override?.terms || []) {
		if (!term || typeof term.text !== "string") continue;
		byText.set(term.text, term);
	}
	result.terms = Array.from(byText.values());
	return result;
}

/**
 * Load custom vocabulary from BUGTOPROMPT_VOCAB (JSON path) and merge over
 * built-in defaults. File errors are logged and fall back to defaults.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {{ readFileSync?: (path: string, encoding: string) => string }} [deps]
 * @returns {{ minSimilarity: number, terms: Array<{ text: string, aliases?: string[], weight?: number }> }}
 */
export function loadVocab(env, deps = {}) {
	const readFileSync = deps.readFileSync || defaultReadFileSync;
	const file = env.BUGTOPROMPT_VOCAB;
	if (!file) return BUILT_IN_VOCAB;
	try {
		const raw = readFileSync(file, "utf8");
		const parsed = JSON.parse(raw);
		return mergeVocab(BUILT_IN_VOCAB, parsed);
	} catch (err) {
		console.error(
			`[local-transcribe] failed to load vocab ${file}: ${String(err)}`,
		);
		return BUILT_IN_VOCAB;
	}
}

export function levenshteinDistance(a, b) {
	const m = a.length;
	const n = b.length;
	if (m === 0) return n;
	if (n === 0) return m;
	let prev = new Array(n + 1);
	let curr = new Array(n + 1);
	for (let j = 0; j <= n; j++) prev[j] = j;
	for (let i = 1; i <= m; i++) {
		curr[0] = i;
		const ca = a[i - 1];
		for (let j = 1; j <= n; j++) {
			const cb = b[j - 1];
			curr[j] = Math.min(
				prev[j] + 1,
				curr[j - 1] + 1,
				prev[j - 1] + (ca === cb ? 0 : 1),
			);
		}
		[prev, curr] = [curr, prev];
	}
	return prev[n];
}

export function similarity(a, b) {
	const maxLen = Math.max(a.length, b.length);
	if (maxLen === 0) return 1;
	return 1 - levenshteinDistance(a, b) / maxLen;
}

/**
 * Post-correct transcribed words using a custom vocabulary.
 *
 * Matches each term and its aliases against single- and multi-word windows.
 * Longer aliases are preferred. Replaces the window with the term text when
 * normalized Levenshtein similarity is >= threshold.
 *
 * @param {Array<{ text: string, start: number, end: number }>} words
 * @param {{ minSimilarity?: number, terms?: Array<{ text: string, aliases?: string[] }> }} [vocab]
 * @returns {Array<{ text: string, start: number, end: number }>}
 */
export function applyVocabulary(words, vocab) {
	if (!Array.isArray(words)) return [];
	const config = vocab || BUILT_IN_VOCAB;
	const threshold = config.minSimilarity ?? 0.72;
	const terms = Array.isArray(config.terms) ? config.terms : [];

	const matchers = [];
	for (const term of terms) {
		if (!term || typeof term.text !== "string") continue;
		matchers.push({ text: term.text, alias: term.text });
		for (const alias of term.aliases || []) {
			if (typeof alias === "string" && alias) {
				matchers.push({ text: term.text, alias });
			}
		}
	}

	matchers.sort((a, b) => {
		const aw = a.alias.trim().split(/\s+/).filter(Boolean).length;
		const bw = b.alias.trim().split(/\s+/).filter(Boolean).length;
		return bw - aw;
	});

	const normalize = (s) =>
		s
			.toLowerCase()
			.replace(/[^\w\s]/g, "")
			.replace(/\s+/g, " ")
			.trim();

	const result = [];
	let i = 0;
	while (i < words.length) {
		let replaced = false;
		for (const { text, alias } of matchers) {
			const aliasWords = alias.trim().split(/\s+/).filter(Boolean);
			const window = words.slice(i, i + aliasWords.length);
			if (window.length < aliasWords.length) continue;
			const windowText = window.map((w) => w.text).join(" ");
			const sim = similarity(normalize(windowText), normalize(alias));
			if (sim >= threshold) {
				const lastWord = window[window.length - 1].text;
				const trailingPunct = lastWord.match(/[^\w\s]+$/)?.[0] || "";
				result.push({
					text: text + trailingPunct,
					start: window[0].start,
					end: window[window.length - 1].end,
				});
				i += aliasWords.length;
				replaced = true;
				break;
			}
		}
		if (!replaced) {
			result.push(words[i]);
			i++;
		}
	}

	return result;
}

/**
 * Reconstruct word-level timings from parakeet-mlx sentence tokens.
 * Tokens use leading whitespace to mark word boundaries; times are seconds.
 *
 * @param {Array<{ text: string, start: number, end: number }>} tokens
 * @returns {Array<{ text: string, start: number, end: number }>}
 */
export function tokensToWords(tokens) {
	const words = [];
	let currentText = "";
	let currentStart = null;
	let currentEnd = null;

	for (const token of tokens) {
		if (!token || typeof token.text !== "string") continue;
		const text = token.text;
		const startMs = Number.isFinite(token.start) ? token.start * 1000 : 0;
		const endMs = Number.isFinite(token.end) ? token.end * 1000 : startMs;

		if (text.startsWith(" ")) {
			if (currentText) {
				words.push({
					text: currentText,
					start: Math.round(currentStart),
					end: Math.round(currentEnd),
				});
			}
			currentText = text.trimStart();
			currentStart = startMs;
			currentEnd = endMs;
		} else {
			if (currentText === "") {
				currentText = text;
				currentStart = startMs;
				currentEnd = endMs;
			} else {
				currentText += text;
				currentEnd = endMs;
			}
		}
	}

	if (currentText) {
		words.push({
			text: currentText,
			start: Math.round(currentStart),
			end: Math.round(currentEnd),
		});
	}

	return words;
}

/**
 * Convert parakeet-mlx JSON output into word-level timings.
 *
 * @param {{ sentences?: Array<{ tokens?: Array<{ text: string, start: number, end: number }> }> }} data
 * @returns {Array<{ text: string, start: number, end: number }>}
 */
export function parakeetJsonToWords(data) {
	const sentences = Array.isArray(data?.sentences) ? data.sentences : [];
	const words = [];
	for (const sentence of sentences) {
		if (!sentence) continue;
		const tokens = Array.isArray(sentence.tokens) ? sentence.tokens : [];
		words.push(...tokensToWords(tokens));
	}
	return words;
}

/**
 * Probe whether the parakeet-mlx CLI is available through `uvx`.
 *
 * @param {(file: string, args: string[], opts?: object) => Promise<{stdout?: string, stderr?: string}>} [execFile]
 * @returns {Promise<boolean>}
 */
export async function detectLocalEngine(execFile) {
	const exec = execFile || execFileAsync;
	try {
		await exec("uvx", ["parakeet-mlx", "--version"]);
		return true;
	} catch {
		return false;
	}
}

/**
 * Transcribe an audio file locally using parakeet-mlx.
 *
 * @param {string} audioPath
 * @param {object} [deps]
 * @param {(file: string, args: string[], opts?: object) => Promise<{stdout?: string, stderr?: string}>} [deps.execFile]
 * @param {(prefix: string) => Promise<string>} [deps.mkdtemp]
 * @param {(path: string, encoding: string) => Promise<string>} [deps.readFile]
 * @param {(path: string, opts?: object) => Promise<void>} [deps.rm]
 * @param {number} [deps.timeoutMs]
 * @param {NodeJS.ProcessEnv} [deps.env]
 * @param {{ minSimilarity?: number, terms?: Array<{ text: string, aliases?: string[] }> }} [deps.vocab]
 * @returns {Promise<Array<{ tStartMs: number, tEndMs: number, text: string }>>}
 */
export async function localTranscribe(audioPath, deps = {}) {
	const execFile = deps.execFile || execFileAsync;
	const mkdtemp = deps.mkdtemp || defaultMkdtemp;
	const readFile = deps.readFile || defaultReadFile;
	const rm = deps.rm || defaultRm;
	const timeoutMs = deps.timeoutMs || LOCAL_TRANSCRIBE_TIMEOUT_MS;
	const env = deps.env || process.env;

	const tmpDir = await mkdtemp(join(tmpdir(), "bugtoprompt-local-"));
	try {
		const wavPath = join(tmpDir, "audio.wav");
		await execFile(
			"ffmpeg",
			[
				"-y",
				"-i",
				audioPath,
				"-ar",
				"16000",
				"-ac",
				"1",
				"-c:a",
				"pcm_s16le",
				wavPath,
			],
			{ timeout: timeoutMs },
		);

		await execFile(
			"uvx",
			[
				"parakeet-mlx",
				wavPath,
				"--output-format",
				"json",
				"--output-dir",
				tmpDir,
			],
			{ timeout: timeoutMs },
		);

		const jsonPath = join(tmpDir, "audio.json");
		const raw = await readFile(jsonPath, "utf8");
		const data = JSON.parse(raw);

		const words = parakeetJsonToWords(data);
		const vocab =
			deps.vocab || loadVocab(env, { readFileSync: deps.readFileSync });
		const corrected = applyVocabulary(words, vocab);

		return groupWordsIntoSegments(corrected);
	} finally {
		await rm(tmpDir, { recursive: true, force: true });
	}
}
