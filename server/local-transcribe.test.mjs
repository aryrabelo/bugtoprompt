import { describe, expect, it, vi } from "vitest";
import {
	applyVocabulary,
	BUILT_IN_VOCAB,
	detectLocalEngine,
	levenshteinDistance,
	loadVocab,
	localTranscribe,
	parakeetJsonToWords,
	resolveTranscribeProvider,
	similarity,
	tokensToWords,
} from "./local-transcribe.mjs";

const makeEnv = (overrides = {}) => ({
	ASSEMBLYAI_API_KEY: undefined,
	BUGTOPROMPT_TRANSCRIBE: undefined,
	...overrides,
});

describe("resolveTranscribeProvider", () => {
	it("picks local when BUGTOPROMPT_TRANSCRIBE=local and CLI is ready", () => {
		expect(
			resolveTranscribeProvider(makeEnv({ BUGTOPROMPT_TRANSCRIBE: "local" }), {
				localReady: true,
			}),
		).toBe("local");
	});

	it("is unconfigured when local is requested but CLI missing", () => {
		expect(
			resolveTranscribeProvider(makeEnv({ BUGTOPROMPT_TRANSCRIBE: "local" }), {
				localReady: false,
			}),
		).toBe("unconfigured");
	});

	it("picks assemblyai when requested and key is present", () => {
		expect(
			resolveTranscribeProvider(
				makeEnv({
					BUGTOPROMPT_TRANSCRIBE: "assemblyai",
					ASSEMBLYAI_API_KEY: "key",
				}),
				{ localReady: false },
			),
		).toBe("assemblyai");
	});

	it("is unconfigured when assemblyai is requested without key", () => {
		expect(
			resolveTranscribeProvider(
				makeEnv({ BUGTOPROMPT_TRANSCRIBE: "assemblyai" }),
				{ localReady: false },
			),
		).toBe("unconfigured");
	});

	it("auto prefers local when CLI is ready", () => {
		expect(resolveTranscribeProvider(makeEnv(), { localReady: true })).toBe(
			"local",
		);
	});

	it("auto falls back to assemblyai when key is present", () => {
		expect(
			resolveTranscribeProvider(makeEnv({ ASSEMBLYAI_API_KEY: "key" }), {
				localReady: false,
			}),
		).toBe("assemblyai");
	});

	it("auto is unconfigured when neither local nor key is available", () => {
		expect(resolveTranscribeProvider(makeEnv(), { localReady: false })).toBe(
			"unconfigured",
		);
	});
});

describe("detectLocalEngine", () => {
	it("returns true when the CLI responds", async () => {
		const execFile = vi.fn().mockResolvedValue({ stdout: "1.0.0" });
		expect(await detectLocalEngine(execFile)).toBe(true);
		expect(execFile).toHaveBeenCalledWith("uvx", ["parakeet-mlx", "--version"]);
	});

	it("returns false when the CLI throws", async () => {
		const execFile = vi.fn().mockRejectedValue(new Error("not found"));
		expect(await detectLocalEngine(execFile)).toBe(false);
	});
});

describe("tokensToWords", () => {
	it("reconstructs words from parakeet subword tokens", () => {
		const tokens = [
			{ text: " H", start: 0.0, end: 0.08 },
			{ text: "ello", start: 0.08, end: 0.16 },
			{ text: " is", start: 0.32, end: 0.4 },
			{ text: "s", start: 0.4, end: 0.48 },
			{ text: "ue", start: 0.48, end: 0.56 },
			{ text: " de", start: 0.72, end: 0.88 },
			{ text: "plo", start: 0.88, end: 0.96 },
			{ text: "y", start: 0.96, end: 1.12 },
			{ text: " com", start: 1.12, end: 1.2 },
			{ text: "mit", start: 1.2, end: 1.36 },
			{ text: ".", start: 1.36, end: 1.44 },
		];
		expect(tokensToWords(tokens)).toEqual([
			{ text: "Hello", start: 0, end: 160 },
			{ text: "issue", start: 320, end: 560 },
			{ text: "deploy", start: 720, end: 1120 },
			{ text: "commit.", start: 1120, end: 1440 },
		]);
	});

	it("skips invalid tokens without crashing", () => {
		expect(tokensToWords([{ text: "hi", start: 0, end: 0.1 }, null])).toEqual([
			{ text: "hi", start: 0, end: 100 },
		]);
	});
});

describe("parakeetJsonToWords", () => {
	it("flattens all sentences into one word array in ms", () => {
		const data = {
			sentences: [
				{
					tokens: [
						{ text: " One", start: 0, end: 0.5 },
						{ text: ".", start: 0.5, end: 0.6 },
					],
				},
				{
					tokens: [
						{ text: " Two", start: 1, end: 1.5 },
						{ text: ".", start: 1.5, end: 1.6 },
					],
				},
			],
		};
		expect(parakeetJsonToWords(data)).toEqual([
			{ text: "One.", start: 0, end: 600 },
			{ text: "Two.", start: 1000, end: 1600 },
		]);
	});

	it("returns [] for empty or malformed input", () => {
		expect(parakeetJsonToWords({})).toEqual([]);
		expect(parakeetJsonToWords(null)).toEqual([]);
		expect(parakeetJsonToWords({ sentences: [] })).toEqual([]);
	});
});

describe("similarity helpers", () => {
	it("computes levenshtein distance", () => {
		expect(levenshteinDistance("kitten", "sitting")).toBe(3);
		expect(levenshteinDistance("", "abc")).toBe(3);
		expect(levenshteinDistance("abc", "abc")).toBe(0);
	});

	it("computes normalized similarity", () => {
		expect(similarity("abc", "abc")).toBe(1);
		expect(similarity("abc", "")).toBe(0);
		expect(similarity("issue", "issues")).toBeCloseTo(0.833, 2);
	});
});

describe("applyVocabulary", () => {
	it("corrects a phrase alias to the term text", () => {
		const words = [
			{ text: "e", start: 0, end: 100 },
			{ text: "sui", start: 120, end: 300 },
			{ text: "deploy", start: 400, end: 800 },
		];
		const vocab = {
			minSimilarity: 0.72,
			terms: [
				{
					text: "issue",
					aliases: ["e sui"],
					weight: 1,
				},
			],
		};
		const result = applyVocabulary(words, vocab);
		expect(result).toEqual([
			{ text: "issue", start: 0, end: 300 },
			{ text: "deploy", start: 400, end: 800 },
		]);
	});

	it("corrects a near-match single word within threshold", () => {
		const words = [
			{ text: "issues", start: 0, end: 100 },
			{ text: "now", start: 120, end: 200 },
		];
		const vocab = {
			minSimilarity: 0.72,
			terms: [{ text: "issue", aliases: [], weight: 1 }],
		};
		const result = applyVocabulary(words, vocab);
		expect(result).toEqual([
			{ text: "issue", start: 0, end: 100 },
			{ text: "now", start: 120, end: 200 },
		]);
	});

	it("preserves words that do not match", () => {
		const words = [{ text: "hello", start: 0, end: 100 }];
		const result = applyVocabulary(words, BUILT_IN_VOCAB);
		expect(result).toEqual([{ text: "hello", start: 0, end: 100 }]);
	});

	it("prefers longer alias matches", () => {
		const words = [
			{ text: "pull", start: 0, end: 100 },
			{ text: "request", start: 120, end: 300 },
		];
		const result = applyVocabulary(words, BUILT_IN_VOCAB);
		expect(result).toEqual([{ text: "pull request", start: 0, end: 300 }]);
	});
});

describe("loadVocab", () => {
	it("returns built-in defaults when no file is configured", () => {
		expect(loadVocab({})).toEqual(BUILT_IN_VOCAB);
	});

	it("merges file terms over built-in defaults", () => {
		const readFileSync = vi.fn().mockReturnValue(
			JSON.stringify({
				minSimilarity: 0.85,
				terms: [
					{ text: "GerarPosts", aliases: ["gerar posts"], weight: 1 },
					{ text: "custom", aliases: [], weight: 1 },
				],
			}),
		);
		const vocab = loadVocab(
			{ BUGTOPROMPT_VOCAB: "/vocab.json" },
			{ readFileSync },
		);
		expect(vocab.minSimilarity).toBe(0.85);
		expect(vocab.terms.find((t) => t.text === "custom")).toBeTruthy();
		expect(vocab.terms.find((t) => t.text === "GerarPosts")?.aliases).toContain(
			"gerar posts",
		);
		expect(vocab.terms.find((t) => t.text === "issue")).toBeTruthy();
	});

	it("falls back to defaults on file error", () => {
		const readFileSync = vi.fn().mockImplementation(() => {
			throw new Error("ENOENT");
		});
		const vocab = loadVocab(
			{ BUGTOPROMPT_VOCAB: "/missing.json" },
			{ readFileSync },
		);
		expect(vocab).toEqual(BUILT_IN_VOCAB);
	});
});

describe("localTranscribe", () => {
	const parakeetFixture = {
		sentences: [
			{
				text: " issue deploy commit.",
				start: 0,
				end: 1.6,
				tokens: [
					{ text: " is", start: 0.0, end: 0.2 },
					{ text: "sue", start: 0.2, end: 0.4 },
					{ text: " de", start: 0.6, end: 0.8 },
					{ text: "ploy", start: 0.8, end: 1.0 },
					{ text: " com", start: 1.2, end: 1.4 },
					{ text: "mit.", start: 1.4, end: 1.6 },
				],
			},
		],
	};

	function makeDeps(overrides = {}) {
		return {
			execFile: vi.fn().mockImplementation((file, _args, _opts) => {
				if (file === "ffmpeg") return Promise.resolve({ stdout: "" });
				if (file === "uvx") return Promise.resolve({ stdout: "" });
				return Promise.reject(new Error(`unexpected ${file}`));
			}),
			mkdtemp: vi.fn().mockResolvedValue("/tmp/bugtoprompt-local-test"),
			readFile: vi.fn().mockResolvedValue(JSON.stringify(parakeetFixture)),
			rm: vi.fn().mockResolvedValue(undefined),
			vocab: BUILT_IN_VOCAB,
			env: {},
			...overrides,
		};
	}

	it("runs ffmpeg, parakeet, and maps to the segment contract", async () => {
		const deps = makeDeps();
		const segments = await localTranscribe("/input/audio.webm", deps);

		expect(deps.execFile).toHaveBeenCalledWith(
			"ffmpeg",
			[
				"-y",
				"-i",
				"/input/audio.webm",
				"-ar",
				"16000",
				"-ac",
				"1",
				"-c:a",
				"pcm_s16le",
				"/tmp/bugtoprompt-local-test/audio.wav",
			],
			{ timeout: 600000 },
		);
		expect(deps.execFile).toHaveBeenCalledWith(
			"uvx",
			[
				"parakeet-mlx",
				"/tmp/bugtoprompt-local-test/audio.wav",
				"--output-format",
				"json",
				"--output-dir",
				"/tmp/bugtoprompt-local-test",
			],
			{ timeout: 600000 },
		);
		expect(deps.readFile).toHaveBeenCalledWith(
			"/tmp/bugtoprompt-local-test/audio.json",
			"utf8",
		);
		expect(segments).toEqual([
			{ tStartMs: 0, tEndMs: 1600, text: "issue deploy commit." },
		]);
		expect(deps.rm).toHaveBeenCalledWith("/tmp/bugtoprompt-local-test", {
			recursive: true,
			force: true,
		});
	});

	it("applies vocabulary correction before grouping", async () => {
		const fixture = {
			sentences: [
				{
					tokens: [
						{ text: " e", start: 0.0, end: 0.1 },
						{ text: " sui", start: 0.1, end: 0.4 },
						{ text: " deploy", start: 0.5, end: 0.9 },
					],
				},
			],
		};
		const vocab = {
			minSimilarity: 0.72,
			terms: [{ text: "issue", aliases: ["e sui"], weight: 1 }],
		};
		const deps = makeDeps({
			readFile: vi.fn().mockResolvedValue(JSON.stringify(fixture)),
			vocab,
		});
		const segments = await localTranscribe("/input/audio.webm", deps);
		expect(segments[0].text).toBe("issue deploy");
	});

	it("uses a custom timeout", async () => {
		const deps = makeDeps({ timeoutMs: 12345 });
		await localTranscribe("/input/audio.webm", deps);
		expect(deps.execFile).toHaveBeenCalledWith("ffmpeg", expect.any(Array), {
			timeout: 12345,
		});
	});

	it("throws on ffmpeg failure so the route can return 502", async () => {
		const deps = makeDeps({
			execFile: vi.fn().mockImplementation((file) => {
				if (file === "ffmpeg")
					return Promise.reject(new Error("ffmpeg failed"));
				return Promise.resolve({ stdout: "" });
			}),
		});
		await expect(localTranscribe("/input/audio.webm", deps)).rejects.toThrow(
			"ffmpeg failed",
		);
	});

	it("throws on parakeet failure so the route can return 502", async () => {
		const deps = makeDeps({
			execFile: vi.fn().mockImplementation((file) => {
				if (file === "uvx") return Promise.reject(new Error("uvx failed"));
				return Promise.resolve({ stdout: "" });
			}),
		});
		await expect(localTranscribe("/input/audio.webm", deps)).rejects.toThrow(
			"uvx failed",
		);
	});

	it("throws on JSON parse failure so the route can return 502", async () => {
		const deps = makeDeps({
			readFile: vi.fn().mockResolvedValue("not json"),
		});
		await expect(localTranscribe("/input/audio.webm", deps)).rejects.toThrow(
			SyntaxError,
		);
	});

	it("cleans up the temp directory even on failure", async () => {
		const deps = makeDeps({
			readFile: vi.fn().mockResolvedValue("not json"),
		});
		await expect(localTranscribe("/input/audio.webm", deps)).rejects.toThrow();
		expect(deps.rm).toHaveBeenCalledWith("/tmp/bugtoprompt-local-test", {
			recursive: true,
			force: true,
		});
	});
});
