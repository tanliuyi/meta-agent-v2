import { fileURLToPath } from "node:url";
import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@juicesharp\/rpiv-i18n(?:\/loader)?$/,
        replacement: fileURLToPath(new URL("./test-i18n.mts", import.meta.url)),
      },
    ],
  },
  test: {
    include: ["**/*.test.ts"],
    setupFiles: ["./test-setup.mts"],
    hookTimeout: 30_000,
    testTimeout: 15_000,
    maxWorkers: Math.max(1, Math.floor(availableParallelism() * 0.6)),
    unstubGlobals: true,
    clearMocks: true,
    restoreMocks: true,
  },
});
