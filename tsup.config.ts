import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

// Inject the package version at build time so the overlay can stamp it in the
// header (BugToPrompt v<version>). Read via fs so it works regardless of cwd.
const { version } = JSON.parse(
	readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

export default defineConfig({
	entry: {
		index: "src/index.ts",
		schema: "src/schema/index.ts",
		render: "src/render/index.ts",
		client: "src/client/index.ts",
	},
	format: ["esm"],
	dts: true,
	clean: true,
	external: ["react", "react-dom", "zod", "lucide-react"],
	define: { __BTP_VERSION__: JSON.stringify(version) },
});
