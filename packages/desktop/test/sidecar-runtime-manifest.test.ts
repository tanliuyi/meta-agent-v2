import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadSidecarRuntimeManifest,
  type SidecarRuntimeManifest,
} from "../src/main/sidecar/sidecar-runtime-manifest.ts";
import { currentRuntimeCompatibility } from "../src/shared/sidecar-wire.ts";

describe("Desktop sidecar runtime manifest", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "desktop-sidecar-runtime-manifest-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("resolves and validates development sidecar assets", () => {
    const appDir = join(root, "out", "main");
    const manifestRoot = join(root, "out", "sidecar");
    writeManifest(manifestRoot, join(manifestRoot, "runtime"));

    const manifest = loadSidecarRuntimeManifest({ isPackaged: false, resourcesPath: root, appDir });

    expect(manifest.entries.thread).toBe(join(manifestRoot, "runtime", "thread.js"));
  });

  it("accepts hashed packaged entries in app.asar.unpacked", () => {
    const manifestRoot = join(root, "resources", "pi-sidecar");
    const runtimeRoot = join(root, "resources", "app.asar.unpacked", "out", "sidecar");
    writeManifest(manifestRoot, runtimeRoot);

    const manifest = loadSidecarRuntimeManifest({
      isPackaged: true,
      resourcesPath: join(root, "resources"),
      appDir: join(root, "unused"),
    });

    expect(manifest.entries.metadata).toContain("app.asar.unpacked");
  });

  it("rejects entries inside app.asar", () => {
    const manifestRoot = join(root, "resources", "pi-sidecar");
    const runtimeRoot = join(root, "resources", "app.asar", "out", "sidecar");
    writeManifest(manifestRoot, runtimeRoot);

    expect(() =>
      loadSidecarRuntimeManifest({
        isPackaged: true,
        resourcesPath: join(root, "resources"),
        appDir: join(root, "unused"),
      }),
    ).toThrow("must be outside app.asar");
  });

  it("rejects corrupt runtime hashes", () => {
    const appDir = join(root, "out", "main");
    const manifestRoot = join(root, "out", "sidecar");
    const runtimeRoot = join(manifestRoot, "runtime");
    writeManifest(manifestRoot, runtimeRoot);
    writeFileSync(join(runtimeRoot, "thread.js"), "corrupt");

    expect(() => loadSidecarRuntimeManifest({ isPackaged: false, resourcesPath: root, appDir })).toThrow(
      "integrity mismatch",
    );
  });

  it("rejects legacy external runtime fields", () => {
    const appDir = join(root, "out", "main");
    const manifestRoot = join(root, "out", "sidecar");
    const manifest = writeManifest(manifestRoot, join(manifestRoot, "runtime"));
    writeFileSync(join(manifestRoot, "runtime-manifest.json"), JSON.stringify({ ...manifest, nodePath: "node" }));

    expect(() => loadSidecarRuntimeManifest({ isPackaged: false, resourcesPath: root, appDir })).toThrow(
      "Legacy external Node fields",
    );
  });

  it("rejects compatibility for a different embedded runtime", () => {
    const appDir = join(root, "out", "main");
    const manifestRoot = join(root, "out", "sidecar");
    const manifest = writeManifest(manifestRoot, join(manifestRoot, "runtime"));
    writeFileSync(
      join(manifestRoot, "runtime-manifest.json"),
      JSON.stringify({ ...manifest, compatibility: { ...manifest.compatibility, modulesAbi: "0" } }),
    );

    expect(() => loadSidecarRuntimeManifest({ isPackaged: false, resourcesPath: root, appDir })).toThrow(
      "compatibility mismatch for modulesAbi",
    );
  });

  function writeManifest(manifestRoot: string, runtimeRoot: string): SidecarRuntimeManifest {
    mkdirSync(manifestRoot, { recursive: true });
    mkdirSync(runtimeRoot, { recursive: true });
    const roles = ["thread", "metadata", "subagent"] as const;
    const entries = Object.fromEntries(
      roles.map((role) => {
        const path = join(runtimeRoot, `${role}.js`);
        writeFileSync(path, role);
        return [role, relative(manifestRoot, path)];
      }),
    ) as SidecarRuntimeManifest["entries"];
    const assetPath = join(runtimeRoot, "asset.txt");
    writeFileSync(assetPath, "asset");
    const manifest: SidecarRuntimeManifest = {
      entries,
      compatibility: currentRuntimeCompatibility("test", "test"),
      integrity: {
        entries: Object.fromEntries(roles.map((role) => [role, hash(role)])) as Record<(typeof roles)[number], string>,
        files: { [relative(manifestRoot, assetPath)]: hash("asset") },
      },
    };
    writeFileSync(join(manifestRoot, "runtime-manifest.json"), JSON.stringify(manifest));
    return manifest;
  }
});

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
