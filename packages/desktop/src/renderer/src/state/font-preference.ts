import { preferencesStorage } from "./preferences-store.ts";

export interface UiFontPreferences {
  /** 自定义 UI 字体族，空字符串表示使用默认字体栈。 */
  fontFamily: string;
  /** 正文字号（px），即 --type-size-body 一档文本的渲染像素；根字号由 CSS 反推。 */
  fontSize: number;
}

export const UI_FONT_FAMILY_STORAGE_KEY = "pi-desktop:ui-font-family";
export const UI_FONT_SIZE_STORAGE_KEY = "pi-desktop:ui-font-size";
export const UI_FONT_FAMILY_PROPERTY = "--ui-font-family";
export const UI_FONT_SIZE_PROPERTY = "--ui-font-size";
export const UI_FONT_FAMILY_MAX_LENGTH = 200;

export const UI_FONT_SIZE_MIN = 10;
export const UI_FONT_SIZE_MAX = 20;
export const UI_FONT_SIZE_DEFAULT = 14;
export const UI_FONT_SIZE_STEP = 0.5;

export const DEFAULT_UI_FONT_PREFERENCES: UiFontPreferences = { fontFamily: "", fontSize: UI_FONT_SIZE_DEFAULT };

/** 早期版本以档位名持久化字号，读取时映射到等效正文像素。 */
const LEGACY_UI_FONT_SIZES: Record<string, number> = {
  small: 12,
  default: UI_FONT_SIZE_DEFAULT,
  large: 16,
  "x-large": 18,
};

interface FontAttributeTarget {
  style: Pick<CSSStyleDeclaration, "setProperty" | "removeProperty">;
}

interface InitializeFontOptions {
  root?: FontAttributeTarget;
  readStoredFontFamily?: () => string | null;
  readStoredFontSize?: () => string | null;
}

/** 收敛到步进刻度并夹取到受支持范围，非有限值回落默认字号。 */
export function clampUiFontSize(value: number): number {
  if (!Number.isFinite(value)) return UI_FONT_SIZE_DEFAULT;
  const stepped = Math.round(value / UI_FONT_SIZE_STEP) * UI_FONT_SIZE_STEP;
  return Math.min(UI_FONT_SIZE_MAX, Math.max(UI_FONT_SIZE_MIN, stepped));
}

export function parseUiFontSize(value: string | null): number {
  if (value === null) return UI_FONT_SIZE_DEFAULT;
  const legacy = LEGACY_UI_FONT_SIZES[value.trim()];
  if (legacy !== undefined) return legacy;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? clampUiFontSize(parsed) : UI_FONT_SIZE_DEFAULT;
}

/**
 * 清洗用户输入的字体族：去掉控制字符与 CSS 声明分隔符并限制长度，
 * 保证写入 custom property 后声明仍然有效。清洗后为空即回到默认字体栈。
 */
export function sanitizeUiFontFamily(value: string | null): string {
  if (!value) return "";
  return value
    .replace(/[\u0000-\u001f\u007f;{}]/gu, "")
    .slice(0, UI_FONT_FAMILY_MAX_LENGTH)
    .trim();
}

export function readStoredUiFontFamily(
  readValue: () => string | null = () => preferencesStorage.getItem(UI_FONT_FAMILY_STORAGE_KEY),
): string {
  try {
    return sanitizeUiFontFamily(readValue());
  } catch {
    return "";
  }
}

export function readStoredUiFontSize(
  readValue: () => string | null = () => preferencesStorage.getItem(UI_FONT_SIZE_STORAGE_KEY),
): number {
  try {
    return parseUiFontSize(readValue());
  } catch {
    return UI_FONT_SIZE_DEFAULT;
  }
}

export function writeStoredUiFontFamily(
  fontFamily: string,
  writeValue: (value: string) => void = (value) => preferencesStorage.setItem(UI_FONT_FAMILY_STORAGE_KEY, value),
): void {
  try {
    writeValue(fontFamily);
  } catch {
    // 当前窗口仍可应用字体，持久化失败不应阻断交互。
  }
}

export function writeStoredUiFontSize(
  fontSize: number,
  writeValue: (value: string) => void = (value) => preferencesStorage.setItem(UI_FONT_SIZE_STORAGE_KEY, value),
): void {
  try {
    writeValue(String(fontSize));
  } catch {
    // 同上，持久化失败不影响本窗口生效。
  }
}

/**
 * 把字体偏好写入 HTML 根节点：字体族与字号各自只经由一个 custom property 注入
 * （`--ui-font-family` / `--ui-font-size`），默认字体栈与 100% 根字号基准由
 * CSS token 唯一拥有，偏好为默认值时移除变量回到 CSS 回退。
 */
export function applyUiFontPreferences(root: FontAttributeTarget, preferences: UiFontPreferences): void {
  if (preferences.fontFamily) root.style.setProperty(UI_FONT_FAMILY_PROPERTY, preferences.fontFamily);
  else root.style.removeProperty(UI_FONT_FAMILY_PROPERTY);
  if (preferences.fontSize === UI_FONT_SIZE_DEFAULT) root.style.removeProperty(UI_FONT_SIZE_PROPERTY);
  else root.style.setProperty(UI_FONT_SIZE_PROPERTY, `${clampUiFontSize(preferences.fontSize)}px`);
}

/**
 * 在 React root 创建前同步恢复持久化字体偏好，避免首帧使用错误字体或字号。
 * 测试可注入 root 与 storage reader，模块加载本身不访问浏览器全局。
 */
export function initializeUiFontPreferences(options: InitializeFontOptions = {}): UiFontPreferences {
  const root = options.root ?? document.documentElement;
  const preferences: UiFontPreferences = {
    fontFamily: readStoredUiFontFamily(options.readStoredFontFamily),
    fontSize: readStoredUiFontSize(options.readStoredFontSize),
  };
  applyUiFontPreferences(root, preferences);
  return preferences;
}
