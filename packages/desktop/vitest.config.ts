import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const packagesRoot = resolve("..");

export default defineConfig({
  resolve: {
    alias: [
      { find: "@renderer", replacement: resolve(import.meta.dirname, "src/renderer/src") },
      {
        find: "@earendil-works/pi-office-engine",
        replacement: resolve(import.meta.dirname, "../office-engine/src/index.ts"),
      },
    ],
  },
});
