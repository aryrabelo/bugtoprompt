import { defineConfig } from "tsup";

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
});
