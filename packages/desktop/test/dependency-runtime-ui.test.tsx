import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DependencyRow } from "../src/renderer/src/features/settings/dependency-row.tsx";
import {
  getCachedShellRuntimeDiagnosis,
  resolveShellRuntimeDiagnosis,
} from "../src/renderer/src/features/shell-runtime/runtime-diagnosis.ts";
import type { ShellRuntimeStatus } from "../src/shared/desktop-api.ts";

const missingShell: ShellRuntimeStatus = {
  state: "missing",
  message: "Git Bash was not found",
  installUrl: "https://gitforwindows.org/",
};

describe("dependency runtime settings UI", () => {
  it("turns rejected Git Bash diagnosis into a blocking invalid status", () => {
    const diagnosis = resolveShellRuntimeDiagnosis(
      { status: "rejected", reason: new Error("shell IPC failed") },
      "win32",
    );

    expect(diagnosis.shellStatus).toMatchObject({
      state: "invalid",
      message: "Git Bash 诊断失败: shell IPC failed",
    });
  });

  it("does not diagnose or block shell dependencies outside Windows", async () => {
    const getShellStatus = vi.fn(async () => missingShell);
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { desktop: { shellRuntime: { getStatus: getShellStatus } } },
    });

    await expect(getCachedShellRuntimeDiagnosis("linux")).resolves.toEqual({ shellStatus: null });
    expect(getShellStatus).not.toHaveBeenCalled();
  });

  it("renders a neutral loading indicator while diagnosis is pending", () => {
    const markup = renderToStaticMarkup(
      createElement(DependencyRow, {
        label: "Git Bash",
        status: null,
        progress: null,
        installing: false,
        busy: true,
        onInstall: async () => true,
      }),
    );

    expect(markup).toContain("检查中");
    expect(markup).toContain("lucide-loader-circle");
    expect(markup).not.toContain("lucide-circle-x");
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

  it("renders installation errors returned by the shell runtime", () => {
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
