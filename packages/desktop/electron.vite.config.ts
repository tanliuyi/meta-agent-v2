import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        external: [
          /^@earendil-works\/pi-(?:ai|agent-core|coding-agent|tui)(?:\/.*)?$/,
          /^jiti(?:\/.*)?$/,
          /^@babel\//,
          /^highlight\.js(?:\/.*)?$/,
        ],
      },
    },
    plugins: [externalizeDepsPlugin()],
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
    plugins: [
      tanstackRouter({
        target: "react",
        autoCodeSplitting: true,
        routesDirectory: resolve("src/renderer/src/app/routes"),
        generatedRouteTree: resolve("src/renderer/src/app/route-tree.gen.ts"),
      }),
      tailwindcss(),
      react(),
    ],
  },
});
