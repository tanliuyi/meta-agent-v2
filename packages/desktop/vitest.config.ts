import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [{ find: "@renderer", replacement: resolve("src/renderer/src") }],
  },
});
