import { defineConfig } from "tsup";

/**
 * Standalone IIFE build — produces dist/bugtoprompt.global.js.
 * Bundles React, ReactDOM, zod, lucide-react, and the overlay into one file.
 * Intended to be dropped in via a <script> tag on any page.
 *
 * Run AFTER build:esm and build:css (the CSS import resolves to dist/bugtoprompt.css).
 * Does NOT clean dist/ so the ESM outputs and CSS are preserved.
 */
export default defineConfig({
	entry: {
		// tsup appends ".global.js" for IIFE format, so "bugtoprompt" → "bugtoprompt.global.js"
		bugtoprompt: "src/standalone.tsx",
	},
	format: ["iife"],
	globalName: "BugToPromptStandalone",
	platform: "browser",
	minify: true,
	dts: false,
	// Nothing is external — React, ReactDOM, zod, lucide-react all get bundled.
	external: [],
	// Load .css files as inline text strings so the stylesheet can be injected
	// programmatically at runtime (no separate <link> required).
	loader: { ".css": "text" },
	// Do NOT clean — ESM outputs and bugtoprompt.css must survive.
	clean: false,
	outDir: "dist",
});
