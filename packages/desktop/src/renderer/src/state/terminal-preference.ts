import { sanitizeUiFontFamily } from "./font-preference.ts";

export interface TerminalPreferences {
  /** 自定义终端字体族，空字符串表示使用默认字体栈。 */
  fontFamily: string;
  /** 终端字号（px）；默认 13 与 CSS token 的 0.8125rem 基准一致。 */
  fontSize: number;
}

export const TERMINAL_FONT_FAMILY_STORAGE_KEY = "pi-desktop:terminal-font-family";
export const TERMINAL_FONT_SIZE_STORAGE_KEY = "pi-desktop:terminal-font-size";
/** 与 styles/tokens.css 的 `--terminal-font-family` / `--terminal-font-size` token 同名。 */
export const TERMINAL_FONT_FAMILY_PROPERTY = "--terminal-font-family";
export const TERMINAL_FONT_SIZE_PROPERTY = "--terminal-font-size";

export const TERMINAL_FONT_SIZE_MIN = 10;
export const TERMINAL_FONT_SIZE_MAX = 24;
export const TERMINAL_FONT_SIZE_DEFAULT = 13;
export const TERMINAL_FONT_SIZE_STEP = 0.5;

export const DEFAULT_TERMINAL_PREFERENCES: TerminalPreferences = {
  fontFamily: "",
  fontSize: TERMINAL_FONT_SIZE_DEFAULT,
};

interface FontAttributeTarget {
  style: Pick<CSSStyleDeclaration, "setProperty" | "removeProperty">;
}

interface InitializeTerminalFontOptions {
  root?: FontAttributeTarget;
  readStoredFontFamily?: () => string | null;
  readStoredFontSize?: () => string | null;
}

/** 收敛到步进刻度并夹取到受支持范围，非有限值回落默认字号。 */
export function clampTerminalFontSize(value: number): number {
  if (!Number.isFinite(value)) return TERMINAL_FONT_SIZE_DEFAULT;
  const stepped = Math.round(value / TERMINAL_FONT_SIZE_STEP) * TERMINAL_FONT_SIZE_STEP;
  return Math.min(TERMINAL_FONT_SIZE_MAX, Math.max(TERMINAL_FONT_SIZE_MIN, stepped));
}

export function parseTerminalFontSize(value: string | null): number {
  if (value === null) return TERMINAL_FONT_SIZE_DEFAULT;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? clampTerminalFontSize(parsed) : TERMINAL_FONT_SIZE_DEFAULT;
}

export function readStoredTerminalFontFamily(
  readValue: () => string | null = () => window.localStorage.getItem(TERMINAL_FONT_FAMILY_STORAGE_KEY),
): string {
  try {
    return sanitizeUiFontFamily(readValue());
  } catch {
    return "";
  }
}

export function readStoredTerminalFontSize(
  readValue: () => string | null = () => window.localStorage.getItem(TERMINAL_FONT_SIZE_STORAGE_KEY),
): number {
  try {
    return parseTerminalFontSize(readValue());
  } catch {
    return TERMINAL_FONT_SIZE_DEFAULT;
  }
}

export function writeStoredTerminalFontFamily(
  fontFamily: string,
  writeValue: (value: string) => void = (value) => window.localStorage.setItem(TERMINAL_FONT_FAMILY_STORAGE_KEY, value),
): void {
  try {
    writeValue(fontFamily);
  } catch {
    // 当前窗口仍可应用字体，持久化失败不应阻断交互。
  }
}

export function writeStoredTerminalFontSize(
  fontSize: number,
  writeValue: (value: string) => void = (value) => window.localStorage.setItem(TERMINAL_FONT_SIZE_STORAGE_KEY, value),
): void {
  try {
    writeValue(String(fontSize));
  } catch {
    // 同上，持久化失败不影响本窗口生效。
  }
}

/**
 * 把终端字体偏好写入 HTML 根节点：默认值移除变量回到 CSS token 回退
 * （tokens.css 的 Consolas 字体栈与 0.8125rem 字号），自定义值才注入变量。
 */
export function applyTerminalPreferences(root: FontAttributeTarget, preferences: TerminalPreferences): void {
  if (preferences.fontFamily) root.style.setProperty(TERMINAL_FONT_FAMILY_PROPERTY, preferences.fontFamily);
  else root.style.removeProperty(TERMINAL_FONT_FAMILY_PROPERTY);
  if (preferences.fontSize === TERMINAL_FONT_SIZE_DEFAULT) root.style.removeProperty(TERMINAL_FONT_SIZE_PROPERTY);
  else root.style.setProperty(TERMINAL_FONT_SIZE_PROPERTY, `${clampTerminalFontSize(preferences.fontSize)}px`);
}

/**
 * 在 React root 创建前同步恢复持久化终端字体偏好，避免首帧终端使用错误字体或字号。
 * 测试可注入 root 与 storage reader，模块加载本身不访问浏览器全局。
 */
export function initializeTerminalPreferences(options: InitializeTerminalFontOptions = {}): TerminalPreferences {
  const root = options.root ?? document.documentElement;
  const preferences: TerminalPreferences = {
    fontFamily: readStoredTerminalFontFamily(options.readStoredFontFamily),
    fontSize: readStoredTerminalFontSize(options.readStoredFontSize),
  };
  applyTerminalPreferences(root, preferences);
  return preferences;
}
