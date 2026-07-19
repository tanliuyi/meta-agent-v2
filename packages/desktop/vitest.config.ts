import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      { find: "@renderer", replacement: resolve("src/renderer/src") },
      {
        find: "@earendil-works/pi-coding-agent/models-config",
        replacement: resolve("../coding-agent/src/core/models-config.ts"),
      },
    ],
  },
});
