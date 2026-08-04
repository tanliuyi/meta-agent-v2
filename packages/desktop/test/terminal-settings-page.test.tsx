import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalSettingsPage } from "../src/renderer/src/features/settings/terminal/terminal-settings-page.tsx";
import {
  normalizeTerminalShellPath,
  terminalShellSaveInput,
} from "../src/renderer/src/features/settings/terminal/terminal-shell-control.tsx";
import { ToastProvider } from "../src/renderer/src/shared/ui/toast-provider.tsx";
import type { SettingsConfigSnapshot } from "../src/shared/settings-config-contracts.ts";

const terminalState = vi.hoisted(() => ({
  fontFamily: "",
  fontSize: 13,
  setFontFamily: vi.fn(),
  setFontSize: vi.fn(),
}));

vi.mock("../src/renderer/src/state/terminal.tsx", () => ({
  useTerminal: () => terminalState,
}));

function snapshot(terminalShellPath: string | null): SettingsConfigSnapshot {
  return {
    path: "/tmp/settings.json",
    exists: true,
    revision: "revision-1",
    settings: {
      showThinking: true,
      autoExpandRunning: true,
      showAvatars: true,
      messageWidth: 810,
      userName: "用户",
      userAvatarPath: null,
      terminalShellPath,
    },
  };
}

describe("TerminalSettingsPage", () => {
  beforeEach(() => {
    terminalState.fontFamily = "";
    terminalState.fontSize = 13;
    vi.stubGlobal("window", { desktop: { settings: { getConfig: vi.fn(), saveConfig: vi.fn() } } });
  });

  it("渲染外观与 Shell 两个配置分区", () => {
    const html = renderToStaticMarkup(
      <ToastProvider label="终端设置">
        <TerminalSettingsPage />
      </ToastProvider>,
    );

    expect(html).toContain("终端");
    expect(html).toContain("外观");
    expect(html).toContain("终端字体");
    expect(html).toContain("终端字号");
    expect(html).toContain("Shell");
    expect(html).toContain("终端 Shell 路径");
    expect(html).toContain('placeholder="留空使用默认 Shell"');
  });
});

describe("terminal shell preference", () => {
  it("空白输入归一化为 null（回退默认）", () => {
    expect(normalizeTerminalShellPath("")).toBeNull();
    expect(normalizeTerminalShellPath("   ")).toBeNull();
    expect(normalizeTerminalShellPath("  /bin/zsh  ")).toBe("/bin/zsh");
  });

  it("配置未变化时不构造保存输入", () => {
    expect(terminalShellSaveInput(snapshot(null), "")).toBeNull();
    expect(terminalShellSaveInput(snapshot("/bin/zsh"), "/bin/zsh")).toBeNull();
  });

  it("构造带当前 revision 与全量设置的保存输入", () => {
    const input = terminalShellSaveInput(snapshot(null), "  /bin/zsh  ");

    expect(input).toEqual({
      expectedRevision: "revision-1",
      settings: {
        showThinking: true,
        autoExpandRunning: true,
        showAvatars: true,
        messageWidth: 810,
        userName: "用户",
        userAvatarPath: null,
        terminalShellPath: "/bin/zsh",
      },
    });
  });

  it("清空已配置路径时构造 null 保存输入", () => {
    const input = terminalShellSaveInput(snapshot("/bin/zsh"), "  ");

    expect(input?.settings.terminalShellPath).toBeNull();
    expect(input?.expectedRevision).toBe("revision-1");
  });
});
