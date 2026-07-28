import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const packagesRoot = resolve("..");

export default defineConfig({
  resolve: {
    alias: [
      { find: "@renderer", replacement: resolve("src/renderer/src") },
      {
        find: /^@earendil-works\/pi-ai\/(.+)$/,
        replacement: resolve(packagesRoot, "ai/src/$1.ts"),
      },
      {
        find: "@earendil-works/pi-ai",
        replacement: resolve(packagesRoot, "ai/src/index.ts"),
      },
      {
        find: "@earendil-works/pi-coding-agent",
        replacement: resolve(packagesRoot, "coding-agent/src/index.ts"),
      },
      {
        find: "@earendil-works/pi-agent-core",
        replacement: resolve(packagesRoot, "agent/src/index.ts"),
      },
      {
        find: "@earendil-works/pi-tui",
        replacement: resolve(packagesRoot, "tui/src/index.ts"),
      },
    ],
  },
});
