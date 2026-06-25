/**
 * Build-time package version, injected by tsup's `define` (see tsup.config.ts
 * and tsup.standalone.config.ts, which read it from package.json). Falls back to
 * "dev" when running unbundled (vitest, ts-node), where the define is absent.
 *
 * Rendered in the overlay header as `BugToPrompt v<VERSION>` so you can confirm
 * at a glance which build a host app is actually serving.
 */
declare const __BTP_VERSION__: string | undefined;

export const VERSION: string =
	typeof __BTP_VERSION__ !== "undefined" ? __BTP_VERSION__ : "dev";
