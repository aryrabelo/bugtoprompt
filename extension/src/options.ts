/**
 * Options page — sidecar URL, screenshot mode, and per-site repo bindings. No
 * credential storage: AssemblyAI keys live in the sidecar process, never here.
 * Validation rejects remote sidecar origins and malformed bindings before save.
 */

import type { ChromeLike, ScreenshotMode, SiteBinding } from "./config";
import {
	isLoopbackHttpUrl,
	isValidBindingHost,
	isValidProjectId,
	loadConfig,
	saveConfig,
} from "./config";

const SCREENSHOT_MODES: ScreenshotMode[] = [
	"onClick",
	"perPage",
	"onMark",
	"off",
];

export function isValidScreenshotMode(value: string): value is ScreenshotMode {
	return SCREENSHOT_MODES.some((mode) => mode === value);
}

/** A raw row as typed in the editor before validation. */
export interface BindingRow {
	host: string;
	projectId: string;
}

/**
 * Validate the editor rows into a clean binding list. Fully-empty rows are
 * dropped; any row with a value in either field must be a valid hostname and
 * `owner/repo` slug, otherwise the whole save is rejected with a message.
 */
export function parseBindingRows(
	rows: BindingRow[],
): { bindings: SiteBinding[] } | { error: string } {
	const bindings: SiteBinding[] = [];
	for (const row of rows) {
		const host = row.host.trim();
		const projectId = row.projectId.trim();
		if (!host && !projectId) continue;
		if (!isValidBindingHost(host)) {
			return {
				error: `Invalid hostname "${host}". Use a bare host like app.example.com or *.example.com.`,
			};
		}
		if (!isValidProjectId(projectId)) {
			return {
				error: `Invalid repo "${projectId}" for ${host}. Use owner/repo.`,
			};
		}
		if (bindings.some((b) => b.host.toLowerCase() === host.toLowerCase())) {
			return {
				error: `Duplicate hostname "${host}". Use one repo binding per host.`,
			};
		}
		bindings.push({ host, projectId });
	}
	return { bindings };
}

// ---------------------------------------------------------------------------
// DOM wiring (skipped under jsdom/tests where there is no options document)
// ---------------------------------------------------------------------------

function addBindingRow(container: HTMLElement, binding?: SiteBinding): void {
	const row = document.createElement("div");
	row.className = "binding-row";

	const host = document.createElement("input");
	host.type = "text";
	host.className = "binding-host";
	host.placeholder = "app.example.com";
	host.value = binding?.host ?? "";

	const repo = document.createElement("input");
	repo.type = "text";
	repo.className = "binding-repo";
	repo.placeholder = "owner/repo";
	repo.value = binding?.projectId ?? "";

	const remove = document.createElement("button");
	remove.type = "button";
	remove.className = "binding-remove";
	remove.textContent = "Remove";
	remove.addEventListener("click", () => {
		row.remove();
	});

	row.append(host, repo, remove);
	container.appendChild(row);
}

function readBindingRows(container: HTMLElement): BindingRow[] {
	const rows: BindingRow[] = [];
	for (const el of container.querySelectorAll(".binding-row")) {
		const host = el.querySelector(".binding-host");
		const repo = el.querySelector(".binding-repo");
		rows.push({
			host: host instanceof HTMLInputElement ? host.value : "",
			projectId: repo instanceof HTMLInputElement ? repo.value : "",
		});
	}
	return rows;
}

async function initOptions(chromeApi: ChromeLike): Promise<void> {
	const urlEl = document.getElementById("baseUrl");
	const modeEl = document.getElementById("screenshotMode");
	const bindingsEl = document.getElementById("bindings");
	const addBtn = document.getElementById("add-binding");
	const saveBtn = document.getElementById("save");
	const statusEl = document.getElementById("status");
	if (
		!(urlEl instanceof HTMLInputElement) ||
		!(modeEl instanceof HTMLSelectElement) ||
		!(bindingsEl instanceof HTMLElement) ||
		!(addBtn instanceof HTMLButtonElement) ||
		!(saveBtn instanceof HTMLButtonElement) ||
		!(statusEl instanceof HTMLElement)
	) {
		return;
	}

	const config = await loadConfig(chromeApi);
	urlEl.value = config.baseUrl;
	modeEl.value = config.screenshotMode;
	for (const binding of config.siteBindings) addBindingRow(bindingsEl, binding);

	addBtn.addEventListener("click", () => {
		addBindingRow(bindingsEl);
	});

	saveBtn.addEventListener("click", () => {
		statusEl.textContent = "";
		const baseUrl = urlEl.value.trim();
		if (!isLoopbackHttpUrl(baseUrl)) {
			statusEl.dataset.tone = "error";
			statusEl.textContent =
				"URL must be a loopback HTTP origin (http://127.0.0.1:PORT or http://localhost:PORT).";
			return;
		}
		const parsed = parseBindingRows(readBindingRows(bindingsEl));
		if ("error" in parsed) {
			statusEl.dataset.tone = "error";
			statusEl.textContent = parsed.error;
			return;
		}
		const screenshotMode = isValidScreenshotMode(modeEl.value)
			? modeEl.value
			: "onClick";
		void (async () => {
			try {
				await saveConfig(chromeApi, {
					baseUrl,
					screenshotMode,
					siteBindings: parsed.bindings,
				});
				statusEl.dataset.tone = "ok";
				statusEl.textContent = "Saved.";
			} catch (err) {
				statusEl.dataset.tone = "error";
				statusEl.textContent =
					err instanceof Error ? err.message : "Failed to save.";
			}
		})();
	});
}

declare const chrome: ChromeLike;
if (typeof chrome !== "undefined" && typeof document !== "undefined") {
	document.addEventListener("DOMContentLoaded", () => {
		void initOptions(chrome);
	});
}
