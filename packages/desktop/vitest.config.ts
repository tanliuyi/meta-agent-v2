import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const packagesRoot = resolve(import.meta.dirname, "..");

export default defineConfig({
  resolve: {
    alias: [
      { find: "@renderer", replacement: resolve(import.meta.dirname, "src/renderer/src") },
      {
        find: /^@earendil-works\/pi-ai\/(.+)$/,
        replacement: resolve(packagesRoot, "ai/src/$1.ts"),
      },
      {
        find: "@earendil-works/pi-ai",
        replacement: resolve(packagesRoot, "ai/src/index.ts"),
      },
    ],
  },
});
