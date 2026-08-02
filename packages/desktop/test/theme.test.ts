import { describe, expect, it, vi } from "vitest";
import {
  applyThemeColorPreferences,
  initializeThemeColor,
  normalizeHexColor,
  parseThemeColorPreference,
  readStoredThemeColorPreferences,
  THEME_ACCENT_FOREGROUND_PROPERTY,
  THEME_ACCENT_PROPERTY,
  themeColorHex,
} from "../src/renderer/src/state/theme-color-preference.ts";
import {
  applyThemePreference,
  DARK_MEDIA_QUERY,
  initializeTheme,
  observeSystemTheme,
  parseThemePreference,
  readStoredThemePreference,
  resolveTheme,
} from "../src/renderer/src/state/theme-preference.ts";

describe("desktop theme", () => {
  it("只接受受支持的持久化偏好", () => {
    expect(parseThemePreference("system")).toBe("system");
    expect(parseThemePreference("light")).toBe("light");
    expect(parseThemePreference("dark")).toBe("dark");
    expect(parseThemePreference("unknown")).toBe("system");
    expect(parseThemePreference(null)).toBe("system");
  });

  it("仅在 system 模式下跟随系统主题", () => {
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("仅写入 HTML 主题数据属性", () => {
    const toggleClass = vi.fn();
    const root = {
      dataset: {} as Record<string, string | undefined>,
      classList: { toggle: toggleClass },
      style: {} as Record<string, string>,
    };

    applyThemePreference(root, "system", "dark");

    expect(root.dataset).toEqual({ theme: "dark", themePreference: "system" });
    expect(toggleClass).not.toHaveBeenCalled();
    expect(root.style).toEqual({});
  });

  it("在 React 启动前恢复偏好并解析系统主题", () => {
    const root = { dataset: {} as Record<string, string | undefined> };

    const resolvedTheme = initializeTheme({
      root,
      readStoredValue: () => "system",
      matchMedia: (query) => {
        expect(query).toBe(DARK_MEDIA_QUERY);
        return { matches: true };
      },
    });

    expect(resolvedTheme).toBe("dark");
    expect(root.dataset).toEqual({ theme: "dark", themePreference: "system" });
  });

  it("持久化不可用时回退到 system", () => {
    expect(
      readStoredThemePreference(() => {
        throw new Error("storage unavailable");
      }),
    ).toBe("system");
  });

  it("立即同步并正确清理系统主题监听", () => {
    let listener: ((event: MediaQueryListEvent) => void) | undefined;
    const addEventListener = vi.fn((_type: "change", next: (event: MediaQueryListEvent) => void) => {
      listener = next;
    });
    const removeEventListener = vi.fn();
    const onChange = vi.fn();
    const media = {
      matches: false,
      addEventListener,
      removeEventListener,
    } as unknown as Pick<MediaQueryList, "matches" | "addEventListener" | "removeEventListener">;

    const cleanup = observeSystemTheme((query) => {
      expect(query).toBe(DARK_MEDIA_QUERY);
      return media;
    }, onChange);

    expect(onChange).toHaveBeenCalledWith(false);
    listener?.({ matches: true } as MediaQueryListEvent);
    expect(onChange).toHaveBeenLastCalledWith(true);

    cleanup();
    expect(removeEventListener).toHaveBeenCalledWith("change", listener);
  });
});

describe("desktop theme color", () => {
  it("只接受受支持的主题色并规范十六进制颜色", () => {
    expect(parseThemeColorPreference("teal")).toBe("teal");
    expect(parseThemeColorPreference("custom")).toBe("custom");
    expect(parseThemeColorPreference("unknown")).toBe("blue");
    expect(normalizeHexColor(" #1a2b3c ")).toBe("#1A2B3C");
    expect(normalizeHexColor("#abc")).toBe("#AABBCC");
    expect(normalizeHexColor("blue")).toBeNull();
  });

  it("预设为浅色与深色外观提供不同色阶", () => {
    expect(themeColorHex("blue", "#000000", "light")).toBe("#2563EB");
    expect(themeColorHex("blue", "#000000", "dark")).toBe("#60A5FA");
    expect(themeColorHex("custom", "#123456", "dark")).toBe("#123456");
  });

  it("内置青碧预设保持人工色阶并使用白色前景", () => {
    const setProperty = vi.fn();
    const root = { dataset: {} as Record<string, string | undefined>, style: { setProperty } };

    applyThemeColorPreferences(root, { preference: "teal", customColor: "#000000" }, "light");

    const accentCall = setProperty.mock.calls.find(([property]) => property === THEME_ACCENT_PROPERTY);
    expect(Number.parseFloat(String(accentCall?.[1]).split(" ")[2])).toBeLessThan(30);
    expect(setProperty).toHaveBeenCalledWith(THEME_ACCENT_FOREGROUND_PROPERTY, "0 0% 100%");
  });

  it("将主题色收敛为可读的 HSL token", () => {
    const setProperty = vi.fn();
    const root = { dataset: {} as Record<string, string | undefined>, style: { setProperty } };

    applyThemeColorPreferences(root, { preference: "custom", customColor: "#000000" }, "dark");

    expect(root.dataset).toEqual({ themeColor: "custom" });
    expect(setProperty).toHaveBeenCalledWith(THEME_ACCENT_PROPERTY, "0 0% 58%");
    expect(setProperty).toHaveBeenCalledWith(THEME_ACCENT_FOREGROUND_PROPERTY, "222 47% 11%");
  });

  it("降低浅色背景上高亮度自定义色的亮度以保留控件边界", () => {
    const setProperty = vi.fn();
    const root = { dataset: {} as Record<string, string | undefined>, style: { setProperty } };

    applyThemeColorPreferences(root, { preference: "custom", customColor: "#FFFF00" }, "light");

    const accentCall = setProperty.mock.calls.find(([property]) => property === THEME_ACCENT_PROPERTY);
    expect(Number.parseFloat(String(accentCall?.[1]).split(" ")[2])).toBeLessThan(34);
    expect(setProperty).toHaveBeenCalledWith(THEME_ACCENT_FOREGROUND_PROPERTY, "222 47% 11%");
  });

  it("在 React 启动前恢复主题色", () => {
    const setProperty = vi.fn();
    const root = { dataset: {} as Record<string, string | undefined>, style: { setProperty } };

    const preferences = initializeThemeColor({
      root,
      resolvedTheme: "light",
      readStoredPreference: () => "rose",
      readStoredCustomColor: () => "#123456",
    });

    expect(preferences).toEqual({ preference: "rose", customColor: "#123456" });
    expect(root.dataset.themeColor).toBe("rose");
    expect(setProperty).toHaveBeenCalledTimes(2);
  });

  it("存储不可用或值无效时回退默认主题色", () => {
    expect(
      readStoredThemeColorPreferences(
        () => "invalid",
        () => "invalid",
      ),
    ).toEqual({
      preference: "blue",
      customColor: "#2563EB",
    });
    expect(
      readStoredThemeColorPreferences(
        () => {
          throw new Error("storage unavailable");
        },
        () => null,
      ),
    ).toEqual({ preference: "blue", customColor: "#2563EB" });
  });
});
