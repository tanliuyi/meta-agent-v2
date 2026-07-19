export const THEME_PREFERENCES = ["system", "light", "dark"] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];
export type ResolvedTheme = Exclude<ThemePreference, "system">;

export const THEME_STORAGE_KEY = "meta-agent:theme";
export const DARK_MEDIA_QUERY = "(prefers-color-scheme: dark)";

interface ThemeAttributeTarget {
  dataset: Record<string, string | undefined>;
}

type ThemeMediaMatcher = (query: string) => Pick<MediaQueryList, "matches">;
type ObservableThemeMediaMatcher = (
  query: string,
) => Pick<MediaQueryList, "matches" | "addEventListener" | "removeEventListener">;

interface InitializeThemeOptions {
  root?: ThemeAttributeTarget;
  readStoredValue?: () => string | null;
  matchMedia?: ThemeMediaMatcher;
}

export function parseThemePreference(value: string | null): ThemePreference {
  return THEME_PREFERENCES.some((preference) => preference === value) ? (value as ThemePreference) : "system";
}

export function resolveTheme(preference: ThemePreference, systemPrefersDark: boolean): ResolvedTheme {
  return preference === "system" ? (systemPrefersDark ? "dark" : "light") : preference;
}

export function readStoredThemePreference(
  readValue: () => string | null = () => window.localStorage.getItem(THEME_STORAGE_KEY),
): ThemePreference {
  try {
    return parseThemePreference(readValue());
  } catch {
    return "system";
  }
}

export function writeStoredThemePreference(
  preference: ThemePreference,
  writeValue: (value: string) => void = (value) => window.localStorage.setItem(THEME_STORAGE_KEY, value),
): void {
  try {
    writeValue(preference);
  } catch {
    // 当前窗口仍可应用主题，持久化失败不应阻断交互。
  }
}

export function readSystemPrefersDark(matchMedia: ThemeMediaMatcher = (query) => window.matchMedia(query)): boolean {
  return matchMedia(DARK_MEDIA_QUERY).matches;
}

/**
 * 将已解析主题写入 HTML 数据属性。CSS token 是颜色与 color-scheme 的唯一所有者，
 * 此函数不得维护 `.dark` class、inline style 或另一份主题值。
 */
export function applyThemePreference(
  root: ThemeAttributeTarget,
  preference: ThemePreference,
  resolvedTheme: ResolvedTheme,
): void {
  root.dataset.theme = resolvedTheme;
  root.dataset.themePreference = preference;
}

/**
 * 在 React root 创建前同步恢复持久化偏好并解析系统主题，避免首帧使用错误 token。
 * 测试可注入 root、storage reader 和 media matcher，模块加载本身不访问浏览器全局。
 */
export function initializeTheme(options: InitializeThemeOptions = {}): ResolvedTheme {
  const root = options.root ?? document.documentElement;
  const preference = readStoredThemePreference(options.readStoredValue);
  const resolvedTheme = resolveTheme(preference, readSystemPrefersDark(options.matchMedia));
  applyThemePreference(root, preference, resolvedTheme);
  return resolvedTheme;
}

/**
 * 订阅系统深色模式并立即同步当前值。立即同步用于覆盖启动与 Provider 挂载之间
 * 可能发生的系统主题变化，返回函数必须在 Provider effect 清理阶段调用。
 */
export function observeSystemTheme(
  matchMedia: ObservableThemeMediaMatcher,
  onChange: (prefersDark: boolean) => void,
): () => void {
  const media = matchMedia(DARK_MEDIA_QUERY);
  const update = (event: MediaQueryListEvent) => onChange(event.matches);
  onChange(media.matches);
  media.addEventListener("change", update);
  return () => media.removeEventListener("change", update);
}
