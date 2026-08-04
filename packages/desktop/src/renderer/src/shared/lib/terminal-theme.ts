export const TERMINAL_COLOR_TOKENS = {
  background: "--terminal-background",
  foreground: "--terminal-foreground",
  cursor: "--terminal-cursor",
  selectionBackground: "--terminal-selection",
  cursorAccent: "--terminal-cursor-accent",
  selectionInactiveBackground: "--terminal-selection-inactive",
  ansiBlack: "--terminal-ansi-black",
  ansiRed: "--terminal-ansi-red",
  ansiGreen: "--terminal-ansi-green",
  ansiYellow: "--terminal-ansi-yellow",
  ansiBlue: "--terminal-ansi-blue",
  ansiMagenta: "--terminal-ansi-magenta",
  ansiCyan: "--terminal-ansi-cyan",
  ansiWhite: "--terminal-ansi-white",
  ansiBrightBlack: "--terminal-ansi-bright-black",
  ansiBrightRed: "--terminal-ansi-bright-red",
  ansiBrightGreen: "--terminal-ansi-bright-green",
  ansiBrightYellow: "--terminal-ansi-bright-yellow",
  ansiBrightBlue: "--terminal-ansi-bright-blue",
  ansiBrightMagenta: "--terminal-ansi-bright-magenta",
  ansiBrightCyan: "--terminal-ansi-bright-cyan",
  ansiBrightWhite: "--terminal-ansi-bright-white",
} as const;
export const TERMINAL_FONT_TOKEN = "--terminal-font-family";
export const TERMINAL_FONT_SIZE_TOKEN = "--terminal-font-size";

interface CssColorTokens {
  getPropertyValue(property: string): string;
}

interface CssFontSizeSource {
  fontSize: string;
  getPropertyValue(property: string): string;
}

export interface TerminalTheme {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
  /** 块状光标下字符色，与 cursor 相反。 */
  cursorAccent: string;
  /** 选区文字色；未提供时由 xterm 自行决定。 */
  selectionForeground?: string;
  /** 终端失焦时的选区背景色。 */
  selectionInactiveBackground?: string;
  /** ANSI 0-15 色（0-7 常规，8-15 高亮）。 */
  ansi: {
    black: string;
    red: string;
    green: string;
    yellow: string;
    blue: string;
    magenta: string;
    cyan: string;
    white: string;
    brightBlack: string;
    brightRed: string;
    brightGreen: string;
    brightYellow: string;
    brightBlue: string;
    brightMagenta: string;
    brightCyan: string;
    brightWhite: string;
  };
}

/**
 * 从 computed style 读取 HSL 通道 token，并转换为第三方渲染器可消费的完整颜色。
 * CSS 是颜色唯一真相源；token 缺失表示样式契约损坏，应立即失败而不是退回 JS 色表。
 */
export function readCssColorToken(style: CssColorTokens, property: string): string {
  const channels = readCssToken(style, property);
  return `hsl(${channels})`;
}

/** 读取第三方控件需要的完整 CSS token 字符串。 */
export function readCssToken(style: CssColorTokens, property: string): string {
  const value = style.getPropertyValue(property).trim();
  if (!value) throw new Error(`Missing CSS token: ${property}`);
  return value;
}

/**
 * 把字号 token 解析为 xterm 需要的像素数值。custom property 的 computed value
 * 不换算相对单位，rem 需按根节点 computed font-size 解析，因此终端字号随
 * UI 字号偏好缩放；取整避免 canvas 渲染发虚。
 */
export function readCssFontSizePx(style: CssFontSizeSource, property: string): number {
  const value = readCssToken(style, property);
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`Invalid CSS font size token: ${property}=${value}`);
  if (value.endsWith("rem")) {
    const rootFontSize = Number.parseFloat(style.fontSize);
    if (!Number.isFinite(rootFontSize) || rootFontSize <= 0) {
      throw new Error(`Cannot resolve rem font size without root font-size: ${property}=${value}`);
    }
    return Math.round(parsed * rootFontSize);
  }
  if (value.endsWith("px")) return Math.round(parsed);
  throw new Error(`Unsupported CSS font size unit: ${property}=${value}`);
}

/**
 * 在主题属性已经由 ThemeProvider 写入 documentElement 后读取 xterm 主题。
 * 调用方应在 Terminal 创建时读取一次，并以 resolvedTheme 变化作为重新读取触发器。
 */
export function resolveTerminalTheme(style: CssColorTokens): TerminalTheme {
  return {
    background: readCssColorToken(style, TERMINAL_COLOR_TOKENS.background),
    foreground: readCssColorToken(style, TERMINAL_COLOR_TOKENS.foreground),
    cursor: readCssColorToken(style, TERMINAL_COLOR_TOKENS.cursor),
    selectionBackground: readCssColorToken(style, TERMINAL_COLOR_TOKENS.selectionBackground),
    cursorAccent: readCssColorToken(style, TERMINAL_COLOR_TOKENS.cursorAccent),
    selectionInactiveBackground: readCssColorToken(style, TERMINAL_COLOR_TOKENS.selectionInactiveBackground),
    ansi: readAnsiColors(style),
  };
}

/** ANSI 0-15 色键，与 TerminalTheme.ansi 字段及 token 命名一一对应。 */
const ANSI_COLOR_KEYS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

function readAnsiColors(style: CssColorTokens): TerminalTheme["ansi"] {
  const ansi = {} as TerminalTheme["ansi"];
  for (const key of ANSI_COLOR_KEYS) {
    const tokenKey = `ansi${key.charAt(0).toUpperCase()}${key.slice(1)}` as keyof typeof TERMINAL_COLOR_TOKENS;
    ansi[key] = readCssColorToken(style, TERMINAL_COLOR_TOKENS[tokenKey]);
  }
  return ansi;
}
