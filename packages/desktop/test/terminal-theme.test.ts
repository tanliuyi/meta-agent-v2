import { describe, expect, it } from "vitest";
import {
  readCssColorToken,
  readCssFontSizePx,
  readCssToken,
  resolveTerminalTheme,
  TERMINAL_COLOR_TOKENS,
  TERMINAL_FONT_SIZE_TOKEN,
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
    const value = 'Consolas, "Cascadia Mono", monospace';
    expect(readCssToken(createStyle({ [TERMINAL_FONT_TOKEN]: ` ${value} ` }), TERMINAL_FONT_TOKEN)).toBe(value);
  });

  it("xterm 字号按根字号解析 rem token 并取整", () => {
    expect(
      readCssFontSizePx(createStyle({ [TERMINAL_FONT_SIZE_TOKEN]: "0.75rem" }, "16px"), TERMINAL_FONT_SIZE_TOKEN),
    ).toBe(12);
    expect(
      readCssFontSizePx(createStyle({ [TERMINAL_FONT_SIZE_TOKEN]: "0.75rem" }, "18.29px"), TERMINAL_FONT_SIZE_TOKEN),
    ).toBe(14);
    expect(
      readCssFontSizePx(createStyle({ [TERMINAL_FONT_SIZE_TOKEN]: "13px" }, "16px"), TERMINAL_FONT_SIZE_TOKEN),
    ).toBe(13);
  });

  it("无效字号 token 明确失败", () => {
    expect(() =>
      readCssFontSizePx(createStyle({ [TERMINAL_FONT_SIZE_TOKEN]: "0.75em" }, "16px"), TERMINAL_FONT_SIZE_TOKEN),
    ).toThrow("Unsupported CSS font size unit");
    expect(() =>
      readCssFontSizePx(createStyle({ [TERMINAL_FONT_SIZE_TOKEN]: "0.75rem" }, ""), TERMINAL_FONT_SIZE_TOKEN),
    ).toThrow("Cannot resolve rem font size");
    expect(() =>
      readCssFontSizePx(createStyle({ [TERMINAL_FONT_SIZE_TOKEN]: "abc" }, "16px"), TERMINAL_FONT_SIZE_TOKEN),
    ).toThrow("Invalid CSS font size token");
  });

  it("从同一份 computed style 解析完整 xterm 主题", () => {
    const style = createStyle({
      [TERMINAL_COLOR_TOKENS.background]: "225 17% 7%",
      [TERMINAL_COLOR_TOKENS.foreground]: "220 15% 86%",
      [TERMINAL_COLOR_TOKENS.cursor]: "220 17% 95%",
      [TERMINAL_COLOR_TOKENS.selectionBackground]: "215 15% 26%",
      [TERMINAL_COLOR_TOKENS.cursorAccent]: "225 17% 7%",
      [TERMINAL_COLOR_TOKENS.selectionInactiveBackground]: "215 15% 26% / 0.5",
      [TERMINAL_COLOR_TOKENS.ansiBlack]: "0 0% 10%",
      [TERMINAL_COLOR_TOKENS.ansiRed]: "0 60% 60%",
      [TERMINAL_COLOR_TOKENS.ansiGreen]: "145 55% 55%",
      [TERMINAL_COLOR_TOKENS.ansiYellow]: "43 90% 62%",
      [TERMINAL_COLOR_TOKENS.ansiBlue]: "210 70% 65%",
      [TERMINAL_COLOR_TOKENS.ansiMagenta]: "280 60% 65%",
      [TERMINAL_COLOR_TOKENS.ansiCyan]: "185 65% 62%",
      [TERMINAL_COLOR_TOKENS.ansiWhite]: "0 0% 85%",
      [TERMINAL_COLOR_TOKENS.ansiBrightBlack]: "0 0% 30%",
      [TERMINAL_COLOR_TOKENS.ansiBrightRed]: "0 65% 70%",
      [TERMINAL_COLOR_TOKENS.ansiBrightGreen]: "145 60% 65%",
      [TERMINAL_COLOR_TOKENS.ansiBrightYellow]: "43 90% 72%",
      [TERMINAL_COLOR_TOKENS.ansiBrightBlue]: "210 75% 75%",
      [TERMINAL_COLOR_TOKENS.ansiBrightMagenta]: "280 65% 75%",
      [TERMINAL_COLOR_TOKENS.ansiBrightCyan]: "185 70% 72%",
      [TERMINAL_COLOR_TOKENS.ansiBrightWhite]: "0 0% 95%",
    });

    expect(resolveTerminalTheme(style)).toEqual({
      background: "hsl(225 17% 7%)",
      foreground: "hsl(220 15% 86%)",
      cursor: "hsl(220 17% 95%)",
      selectionBackground: "hsl(215 15% 26%)",
      cursorAccent: "hsl(225 17% 7%)",
      selectionInactiveBackground: "hsl(215 15% 26% / 0.5)",
      ansi: {
        black: "hsl(0 0% 10%)",
        red: "hsl(0 60% 60%)",
        green: "hsl(145 55% 55%)",
        yellow: "hsl(43 90% 62%)",
        blue: "hsl(210 70% 65%)",
        magenta: "hsl(280 60% 65%)",
        cyan: "hsl(185 65% 62%)",
        white: "hsl(0 0% 85%)",
        brightBlack: "hsl(0 0% 30%)",
        brightRed: "hsl(0 65% 70%)",
        brightGreen: "hsl(145 60% 65%)",
        brightYellow: "hsl(43 90% 72%)",
        brightBlue: "hsl(210 75% 75%)",
        brightMagenta: "hsl(280 65% 75%)",
        brightCyan: "hsl(185 70% 72%)",
        brightWhite: "hsl(0 0% 95%)",
      },
    });
  });
});

function createStyle(tokens: Readonly<Record<string, string>>, fontSize = "16px") {
  return {
    fontSize,
    getPropertyValue(property: string): string {
      return tokens[property] ?? "";
    },
  };
}
