import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareDesktopManagedShell } from "../../../scripts/prepare-desktop-managed-shell.mjs";
import { locateManagedBash } from "../src/main/sidecar/managed-shell-locator.ts";

describe("Desktop managed Bash locator", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "desktop-managed-shell-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("locates the packaged Windows runtime outside app.asar", () => {
    const shellPath = join(root, "managed-shell", "bin", "bash.exe");
    mkdirSync(join(root, "managed-shell", "bin"), { recursive: true });
    writeFileSync(shellPath, "");

    expect(locateManagedBash({ isPackaged: true, resourcesPath: root, appDir: "unused", platform: "win32" })).toBe(
      shellPath,
    );
  });

  it("locates the prepared runtime during development", () => {
    const appDir = join(root, "out", "main");
    const shellPath = join(root, "output", "managed-shell", "bin", "bash.exe");
    mkdirSync(join(root, "output", "managed-shell", "bin"), { recursive: true });
    writeFileSync(shellPath, "");

    expect(locateManagedBash({ isPackaged: false, resourcesPath: "unused", appDir, platform: "win32" })).toBe(
      shellPath,
    );
  });

  it("does not expose the Windows runtime on other platforms or when it is missing", () => {
    expect(
      locateManagedBash({ isPackaged: true, resourcesPath: root, appDir: root, platform: "linux" }),
    ).toBeUndefined();
    expect(
      locateManagedBash({ isPackaged: true, resourcesPath: root, appDir: root, platform: "win32" }),
    ).toBeUndefined();
  });

  it("skips preparation outside Windows and rejects unsupported Windows architectures", async () => {
    await expect(prepareDesktopManagedShell({ platform: "linux" })).resolves.toBeUndefined();
    await expect(prepareDesktopManagedShell({ platform: "win32", arch: "mips" })).rejects.toThrow(
      "Unsupported Windows managed shell architecture: mips",
    );
  });
});
