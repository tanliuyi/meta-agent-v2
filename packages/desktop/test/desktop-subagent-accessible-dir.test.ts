import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { ensureAccessibleDir } from "../src/main/pi/extensions/pi-subagents/src/shared/accessible-dir.ts";

describe("Desktop subagent accessible directories", () => {
  it("retries a transient EPERM before confirming directory access", () => {
    let mkdirAttempts = 0;
    const accessSync = vi.fn();
    const wait = vi.fn();

    ensureAccessibleDir("C:\\temp\\subagent-results", {
      fs: {
        mkdirSync: () => {
          mkdirAttempts += 1;
          if (mkdirAttempts === 1) {
            throw Object.assign(new Error("directory is temporarily locked"), { code: "EPERM" });
          }
          return undefined;
        },
        accessSync,
      },
      retryDirectoryErrors: true,
      retryDelaysMs: [7],
      wait,
    });

    expect(mkdirAttempts).toBe(2);
    expect(wait).toHaveBeenCalledOnce();
    expect(wait).toHaveBeenCalledWith(7);
    expect(accessSync).toHaveBeenCalledOnce();
  });

  it("keeps the extension entrypoint on the shared accessible-dir helper", () => {
    const extensionPath = fileURLToPath(
      new URL("../src/main/pi/extensions/pi-subagents/src/extension/index.ts", import.meta.url),
    );
    const source = readFileSync(extensionPath, "utf8");

    expect(source).toContain('import { ensureAccessibleDir } from "../shared/accessible-dir.ts";');
    expect(source).toContain("ensureAccessibleDir(DIRS.results);");
    expect(source).toContain("ensureAccessibleDir(DIRS.async);");
  });
});
