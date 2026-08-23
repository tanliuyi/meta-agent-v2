import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
  main: {
    define: {
      __DESKTOP_UPDATE_URLS__: JSON.stringify(process.env.PI_DESKTOP_UPDATE_URLS ?? ""),
    },
    build: {
      rollupOptions: {
        output: { format: "cjs" },
        external: [
          /^@earendil-works\/pi-(?:agent-core|coding-agent|tui)(?:\/.*)?$/,
          /^jiti(?:\/.*)?$/,
          /^@babel\//,
          /^highlight\.js(?:\/.*)?$/,
        ],
      },
    },
    plugins: [externalizeDepsPlugin({ exclude: ["@earendil-works/pi-ai"] })],
  },
  preload: {
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/preload/index.ts"),
          "browser-internal": resolve("src/preload/browser-internal.ts"),
        },
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    worker: {
      format: "es",
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/renderer/index.html"),
          "browser-internal": resolve("src/renderer/browser-internal.html"),
        },
      },
    },
    optimizeDeps: {
      include: ["@rc-component/image"],
    },
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
