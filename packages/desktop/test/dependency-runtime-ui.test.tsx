import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  getCachedRuntimeDiagnosis,
  resolveRuntimeDiagnosis,
} from "../src/renderer/src/features/node-runtime/runtime-diagnosis.ts";
import { runtimeKindsToInstall } from "../src/renderer/src/features/settings/dependencies-settings-page.tsx";
import { DependencyRow } from "../src/renderer/src/features/settings/dependency-row.tsx";
import type { NodeRuntimeStatus, ShellRuntimeStatus } from "../src/shared/desktop-api.ts";

const readyNode: NodeRuntimeStatus = {
  state: "ready",
  path: "C:\\node.exe",
  version: "v24.15.0",
  requiredVersion: "24.15.0",
  message: "Node.js is ready",
  installUrl: "https://nodejs.org/",
};

const missingShell: ShellRuntimeStatus = {
  state: "missing",
  message: "Git Bash was not found",
  installUrl: "https://gitforwindows.org/",
};

describe("dependency runtime settings UI", () => {
  it("installs only runtimes that are not ready", () => {
    expect(runtimeKindsToInstall(readyNode, missingShell, "win32")).toEqual(["shell"]);
    expect(runtimeKindsToInstall(readyNode, missingShell, "linux")).toEqual([]);
    expect(runtimeKindsToInstall(null, null, "win32")).toEqual(["node", "shell"]);
  });

  it("turns rejected diagnostics into blocking invalid statuses", () => {
    const diagnosis = resolveRuntimeDiagnosis(
      { status: "rejected", reason: new Error("node IPC failed") },
      { status: "rejected", reason: new Error("shell IPC failed") },
      "win32",
    );

    expect(diagnosis.nodeStatus).toMatchObject({ state: "invalid", message: "Node.js 诊断失败: node IPC failed" });
    expect(diagnosis.shellStatus).toMatchObject({ state: "invalid", message: "Git Bash 诊断失败: shell IPC failed" });
  });

  it("preserves successful diagnostics when another runtime check fails", () => {
    const diagnosis = resolveRuntimeDiagnosis(
      { status: "fulfilled", value: readyNode },
      { status: "rejected", reason: new Error("shell IPC failed") },
      "win32",
    );

    expect(diagnosis.nodeStatus.state).toBe("ready");
    expect(diagnosis.shellStatus).toMatchObject({ state: "invalid", message: "Git Bash 诊断失败: shell IPC failed" });
    expect(runtimeKindsToInstall(diagnosis.nodeStatus, diagnosis.shellStatus, "win32")).toEqual(["shell"]);
  });

  it("caches runtime diagnosis for the renderer lifetime", async () => {
    const getNodeStatus = vi.fn(async () => readyNode);
    const getShellStatus = vi.fn(async () => missingShell);
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        desktop: {
          nodeRuntime: { getStatus: getNodeStatus },
          shellRuntime: { getStatus: getShellStatus },
        },
      },
    });

    const first = await getCachedRuntimeDiagnosis("win32");
    const second = await getCachedRuntimeDiagnosis("win32");

    expect(first).toBe(second);
    expect(getNodeStatus).toHaveBeenCalledTimes(1);
    expect(getShellStatus).toHaveBeenCalledTimes(1);
  });

  it("renders actionable status details without disabling recovery installation", () => {
    const markup = renderToStaticMarkup(
      createElement(DependencyRow, {
        label: "Git Bash",
        status: {
          ...missingShell,
          state: "invalid",
          message: "Custom shell path not found: C:\\missing\\bash.exe",
        },
        progress: null,
        installing: false,
        busy: false,
        onInstall: async () => true,
        onChoose: async () => undefined,
      }),
    );

    expect(markup).toContain("Custom shell path not found");
    expect(markup).toContain('role="alert"');
    expect(markup).not.toContain(' disabled=""');
  });

  it("renders installation errors returned by the runtime", () => {
    const markup = renderToStaticMarkup(
      createElement(DependencyRow, {
        label: "Git Bash",
        status: missingShell,
        progress: { phase: "error", percent: 0, message: "安装失败", error: "network unavailable" },
        installing: false,
        busy: false,
        onInstall: async () => true,
      }),
    );

    expect(markup).toContain("network unavailable");
  });
});
