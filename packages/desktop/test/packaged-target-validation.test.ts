import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertTargetRuntime, validateManagedShell } from "../../../scripts/validate-desktop-package.mjs";

const manifest = (platform: string, arch: string) => ({ compatibility: { platform, arch } });

describe("packaged Desktop target validation", () => {
  it("accepts a runtime matching the electron-builder target", () => {
    expect(() =>
      assertTargetRuntime({ electronPlatformName: "win32", arch: 1 }, manifest("win32", "x64")),
    ).not.toThrow();
  });

  it("rejects a host runtime that does not match the target platform or arch", () => {
    expect(() => assertTargetRuntime({ electronPlatformName: "win32", arch: 1 }, manifest("darwin", "arm64"))).toThrow(
      "package=win32/x64, runtime=darwin/arm64",
    );
  });

  it("rejects universal packaging until both sidecar runtimes are materialized", () => {
    expect(() => assertTargetRuntime({ electronPlatformName: "darwin", arch: 4 }, manifest("darwin", "arm64"))).toThrow(
      "Universal Desktop packaging requires per-architecture sidecar runtimes",
    );
  });

  it("rejects a Windows package without the managed Bash executable or manifest", () => {
    const resources = mkdtempSync(join(tmpdir(), "desktop-managed-shell-package-"));
    try {
      expect(() => validateManagedShell(resources)).toThrow("Managed Bash is missing from package");
      const root = join(resources, "managed-shell");
      mkdirSync(join(root, "bin"), { recursive: true });
      writeFileSync(join(root, "bin", "bash.exe"), "");
      expect(() => validateManagedShell(resources)).toThrow("Managed Bash manifest is missing from package");
    } finally {
      rmSync(resources, { recursive: true, force: true });
    }
  });
});
