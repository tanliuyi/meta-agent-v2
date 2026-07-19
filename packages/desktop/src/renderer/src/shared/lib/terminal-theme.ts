export const TERMINAL_COLOR_TOKENS = {
  background: "--terminal-background",
  foreground: "--terminal-foreground",
  cursor: "--terminal-cursor",
  selectionBackground: "--terminal-selection",
} as const;
export const TERMINAL_FONT_TOKEN = "--font-family-mono";

interface CssColorTokens {
  getPropertyValue(property: string): string;
}

export interface TerminalTheme {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
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
 * 在主题属性已经由 ThemeProvider 写入 documentElement 后读取 xterm 主题。
 * 调用方应在 Terminal 创建时读取一次，并以 resolvedTheme 变化作为重新读取触发器。
 */
export function resolveTerminalTheme(style: CssColorTokens): TerminalTheme {
  return {
    background: readCssColorToken(style, TERMINAL_COLOR_TOKENS.background),
    foreground: readCssColorToken(style, TERMINAL_COLOR_TOKENS.foreground),
    cursor: readCssColorToken(style, TERMINAL_COLOR_TOKENS.cursor),
    selectionBackground: readCssColorToken(style, TERMINAL_COLOR_TOKENS.selectionBackground),
  };
}
