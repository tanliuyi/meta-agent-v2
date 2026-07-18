import { describe, expect, it } from "vitest";
import { parseThemePreference, resolveTheme } from "../src/renderer/src/state/theme.tsx";

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
});
