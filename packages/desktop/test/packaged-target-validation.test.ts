import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertEmbeddedRuntimeManifest,
  assertHiddenMacSidecarHelper,
  assertTargetRuntime,
  resolvePackagedExecutable,
} from "../../../scripts/validate-desktop-package.mjs";

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

  it("resolves the packaged Electron executable for the target layout", () => {
    expect(
      resolvePackagedExecutable({
        appOutDir: "C:\\artifact",
        electronPlatformName: "win32",
        packager: { appInfo: { productFilename: "Meta Agent" }, executableName: "Meta Agent" },
      }),
    ).toBe(join("C:\\artifact", "Meta Agent.exe"));
  });

  it("requires the packaged macOS sidecar Helper to be executable and hidden from the Dock", () => {
    const root = mkdtempSync(join(tmpdir(), "desktop-helper-validation-"));
    const contents = join(root, "Meta Agent Helper.app", "Contents");
    const executable = join(contents, "MacOS", "Meta Agent Helper");
    try {
      mkdirSync(dirname(executable), { recursive: true });
      writeFileSync(executable, "", { mode: 0o755 });
      writeFileSync(join(contents, "Info.plist"), "<plist><dict><key>LSUIElement</key><true/></dict></plist>");
      expect(() => assertHiddenMacSidecarHelper(executable)).not.toThrow();

      writeFileSync(join(contents, "Info.plist"), "<plist><dict></dict></plist>");
      expect(() => assertHiddenMacSidecarHelper(executable)).toThrow("does not set LSUIElement=true");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects legacy or bundled external Node runtime contracts", () => {
    const resources = mkdtempSync(join(tmpdir(), "desktop-embedded-runtime-"));
    try {
      expect(() => assertEmbeddedRuntimeManifest(resources, { entries: {}, integrity: {} })).not.toThrow();
      expect(() =>
        assertEmbeddedRuntimeManifest(resources, { nodePath: "system", entries: {}, integrity: {} }),
      ).toThrow("legacy external Node fields");
      mkdirSync(join(resources, "node-runtime"));
      expect(() => assertEmbeddedRuntimeManifest(resources, { entries: {}, integrity: {} })).toThrow(
        "external Node runtime",
      );
    } finally {
      rmSync(resources, { recursive: true, force: true });
    }
  });

  it("keeps the installer shell-only and PortableGit out of the standard Windows package", () => {
    const config = readFileSync(resolve(import.meta.dirname, "../electron-builder.yml"), "utf8");
    const installer = readFileSync(resolve(import.meta.dirname, "../build/installer.nsh"), "utf8");
    expect(config).toContain("include: build/installer.nsh");
    expect(config).not.toContain("output/managed-shell");
    expect(installer).toContain("--runtime-setup=$RuntimeComponents");
    expect(installer).not.toContain("RuntimeNodeCheckbox");
    expect(installer).not.toContain("node-runtime");
  });

  it("does not treat WSL or another bash.exe on PATH as Git Bash", () => {
    const installer = readFileSync(resolve(import.meta.dirname, "../build/installer.nsh"), "utf8");
    expect(installer).toContain("$LOCALAPPDATA\\Programs\\Git\\bin\\bash.exe");
    expect(installer).not.toContain('SearchPath $0 "bash.exe"');
    expect(installer).not.toContain("shell-runtime\\active.json");
  });
});
