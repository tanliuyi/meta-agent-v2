import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
	main: {
		build: {
			rollupOptions: {
				external: [/^jiti(?:\/.*)?$/, /^@babel\//, /^highlight\.js(?:\/.*)?$/],
			},
		},
		resolve: {
			alias: [
				{ find: "@earendil-works/pi-ai/compat", replacement: resolve("../ai/src/compat.ts") },
				{ find: "@earendil-works/pi-ai/oauth", replacement: resolve("../ai/src/oauth.ts") },
				{ find: "@earendil-works/pi-ai", replacement: resolve("../ai/src/index.ts") },
				{ find: "@earendil-works/pi-agent-core", replacement: resolve("../agent/src/index.ts") },
				{ find: "@earendil-works/pi-coding-agent", replacement: resolve("../coding-agent/src/index.ts") },
				{ find: "@earendil-works/pi-tui", replacement: resolve("../tui/src/index.ts") },
			],
		},
		plugins: [
			externalizeDepsPlugin({
				exclude: [
					"@earendil-works/pi-ai",
					"@earendil-works/pi-agent-core",
					"@earendil-works/pi-coding-agent",
					"@earendil-works/pi-tui",
				],
			}),
		],
	},
	preload: {
		build: {
			rollupOptions: {
				output: { format: "cjs" },
			},
		},
		plugins: [externalizeDepsPlugin()],
	},
	renderer: {
		resolve: {
			alias: {
				"@renderer": resolve("src/renderer/src"),
			},
		},
		plugins: [react()],
	},
});
