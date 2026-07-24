import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const childProcessMock = vi.hoisted(() => ({ execFileSync: vi.fn() }));
vi.mock("node:child_process", () => ({ execFileSync: childProcessMock.execFileSync }));

import {
  detectNodeRuntime,
  loadNodeRuntimeManifest,
  type NodeRuntimeManifest,
} from "../src/main/sidecar/node-runtime-locator.ts";

describe("Desktop Node runtime locator", () => {
  let resourcesPath: string;
  const savedNodeExecPath = process.env.PI_DESKTOP_NODE_EXEC_PATH;

  beforeEach(() => {
    childProcessMock.execFileSync.mockReset();
    delete process.env.PI_DESKTOP_NODE_EXEC_PATH;
    resourcesPath = mkdtempSync(join(tmpdir(), "desktop-node-runtime-locator-"));
  });

  afterEach(() => {
    rmSync(resourcesPath, { recursive: true, force: true });
    if (savedNodeExecPath === undefined) delete process.env.PI_DESKTOP_NODE_EXEC_PATH;
    else process.env.PI_DESKTOP_NODE_EXEC_PATH = savedNodeExecPath;
  });

  it("rejects executable paths inside app.asar", () => {
    const manifestPath = writeManifest("app.asar");

    expect(() =>
      loadNodeRuntimeManifest({ isPackaged: true, resourcesPath, appDir: join(resourcesPath, "unused") }),
    ).toThrow(`Node executable must be outside app.asar`);
    expect(manifestPath).toBe(join(resourcesPath, "pi-sidecar", "runtime-manifest.json"));
  });

  it("accepts hashed files in app.asar.unpacked", () => {
    writeManifest("app.asar.unpacked");

    const manifest = loadNodeRuntimeManifest({
      isPackaged: true,
      resourcesPath,
      appDir: join(resourcesPath, "unused"),
    });

    expect(manifest.nodePath).toContain("app.asar.unpacked");
    expect(manifest.entries.thread).toContain("app.asar.unpacked");
  });

  it.each(["v22.19.0", "v24.15.0", "v25.0.0"])("accepts compatible Node runtime %s", (nodeVersion) => {
    mockNodeRuntime({ nodeVersion });

    expect(detectNodeRuntime(join(resourcesPath, "node"))).toMatchObject({
      state: "ready",
      version: nodeVersion,
    });
  });

  it("rejects a Node runtime for another architecture", () => {
    const arch = process.arch === "arm64" ? "x64" : "arm64";
    mockNodeRuntime({ arch });

    expect(detectNodeRuntime(join(resourcesPath, "node"))).toMatchObject({
      state: "invalid",
      version: "v24.15.0",
      message: expect.stringContaining(`需要 ${process.platform}/${process.arch}，当前为 ${process.platform}/${arch}`),
    });
  });

  it("rejects a Node runtime for another platform", () => {
    const platform = process.platform === "darwin" ? "linux" : "darwin";
    mockNodeRuntime({ platform });

    expect(detectNodeRuntime(join(resourcesPath, "node"))).toMatchObject({
      state: "invalid",
      version: "v24.15.0",
      message: expect.stringContaining(`需要 ${process.platform}/${process.arch}，当前为 ${platform}/${process.arch}`),
    });
  });

  it.each([{ modulesAbi: "unknown" }, { napi: "unknown" }])("does not accept invalid ABI metadata: %o", (metadata) => {
    mockNodeRuntime(metadata);

    expect(detectNodeRuntime(join(resourcesPath, "node"))).toMatchObject({ state: "missing" });
  });

  it("rejects an incompatible manifest Node override", () => {
    writeManifest("app.asar.unpacked");
    const nodePath = writeRuntimeFile(join(resourcesPath, "node"), "node");
    mockNodeRuntime({ arch: process.arch === "arm64" ? "x64" : "arm64" });

    expect(() =>
      loadNodeRuntimeManifest({
        isPackaged: true,
        resourcesPath,
        appDir: join(resourcesPath, "unused"),
        nodePathOverride: nodePath,
      }),
    ).toThrow("与当前 Desktop 不兼容");
  });

  function writeManifest(container: string): string {
    const manifestRoot = join(resourcesPath, "pi-sidecar");
    const runtimeRoot = join(resourcesPath, container, "runtime");
    mkdirSync(manifestRoot, { recursive: true });
    mkdirSync(runtimeRoot, { recursive: true });
    const nodePath = writeRuntimeFile(join(runtimeRoot, "node"), "node");
    const npmCliPath = writeRuntimeFile(join(runtimeRoot, "npm-cli.js"), "npm");
    const roles = ["thread", "metadata", "subagent"] as const;
    const entries = Object.fromEntries(
      roles.map((role) => [role, writeRuntimeFile(join(runtimeRoot, `${role}.js`), role)]),
    ) as NodeRuntimeManifest["entries"];
    const manifest: NodeRuntimeManifest = {
      nodePath: relative(manifestRoot, nodePath),
      npmCliPath: relative(manifestRoot, npmCliPath),
      entries: Object.fromEntries(
        Object.entries(entries).map(([role, path]) => [role, relative(manifestRoot, path)]),
      ) as NodeRuntimeManifest["entries"],
      compatibility: {
        nodeVersion: process.version,
        modulesAbi: process.versions.modules,
        napi: process.versions.napi ?? "unknown",
        platform: process.platform,
        arch: process.arch,
        osRelease: "test",
        libc: "test",
        toolchain: "test",
        piVersion: "test",
        runtimeCompatibilityId: "test",
      },
      integrity: {
        nodePath: hash("node"),
        npmCliPath: hash("npm"),
        entries: Object.fromEntries(roles.map((role) => [role, hash(role)])) as NodeRuntimeManifest["entries"],
        files: {},
      },
    };
    const manifestPath = join(manifestRoot, "runtime-manifest.json");
    writeFileSync(manifestPath, JSON.stringify(manifest));
    return manifestPath;
  }
});

function mockNodeRuntime(
  overrides: Partial<{
    nodeVersion: string;
    modulesAbi: string;
    napi: string;
    platform: string;
    arch: string;
  }> = {},
): void {
  childProcessMock.execFileSync.mockReturnValue(
    JSON.stringify({
      nodeVersion: "v24.15.0",
      modulesAbi: "137",
      napi: "10",
      platform: process.platform,
      arch: process.arch,
      ...overrides,
    }),
  );
}

function writeRuntimeFile(path: string, content: string): string {
  writeFileSync(path, content);
  return path;
}

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
