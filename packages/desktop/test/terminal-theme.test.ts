import { describe, expect, it } from "vitest";
import {
  readCssColorToken,
  readCssToken,
  resolveTerminalTheme,
  TERMINAL_COLOR_TOKENS,
  TERMINAL_FONT_TOKEN,
} from "../src/renderer/src/shared/lib/terminal-theme.ts";

describe("terminal theme", () => {
  it("清理 token 两端空白并生成完整 HSL 颜色", () => {
    const style = createStyle({ "--terminal-background": "  220 20% 98%  " });

    expect(readCssColorToken(style, "--terminal-background")).toBe("hsl(220 20% 98%)");
  });

  it("缺失 token 时明确失败", () => {
    expect(() => readCssColorToken(createStyle({}), "--terminal-cursor")).toThrow(
      "Missing CSS token: --terminal-cursor",
    );
  });

  it("xterm 字体直接读取 CSS 字体 token", () => {
    const value = '"Cascadia Mono", Consolas, monospace';
    expect(readCssToken(createStyle({ [TERMINAL_FONT_TOKEN]: ` ${value} ` }), TERMINAL_FONT_TOKEN)).toBe(value);
  });

  it("从同一份 computed style 解析完整 xterm 主题", () => {
    const style = createStyle({
      [TERMINAL_COLOR_TOKENS.background]: "225 17% 7%",
      [TERMINAL_COLOR_TOKENS.foreground]: "220 15% 86%",
      [TERMINAL_COLOR_TOKENS.cursor]: "220 17% 95%",
      [TERMINAL_COLOR_TOKENS.selectionBackground]: "215 15% 26%",
    });

    expect(resolveTerminalTheme(style)).toEqual({
      background: "hsl(225 17% 7%)",
      foreground: "hsl(220 15% 86%)",
      cursor: "hsl(220 17% 95%)",
      selectionBackground: "hsl(215 15% 26%)",
    });
  });
});

function createStyle(tokens: Readonly<Record<string, string>>) {
  return {
    getPropertyValue(property: string): string {
      return tokens[property] ?? "";
    },
  };
}
