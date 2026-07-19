import { describe, expect, it, vi } from "vitest";
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
