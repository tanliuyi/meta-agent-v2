import { describe, expect, it, vi } from "vitest";
import {
  applyUiFontPreferences,
  clampUiFontSize,
  initializeUiFontPreferences,
  parseUiFontSize,
  readStoredUiFontFamily,
  readStoredUiFontSize,
  sanitizeUiFontFamily,
  UI_FONT_FAMILY_MAX_LENGTH,
  UI_FONT_FAMILY_PROPERTY,
  UI_FONT_SIZE_DEFAULT,
  UI_FONT_SIZE_MAX,
  UI_FONT_SIZE_MIN,
  UI_FONT_SIZE_PROPERTY,
  writeStoredUiFontFamily,
  writeStoredUiFontSize,
} from "../src/renderer/src/state/font-preference.ts";

function createRoot() {
  const properties = new Map<string, string>();
  return {
    style: {
      setProperty: vi.fn((name: string, value: string) => void properties.set(name, value)),
      removeProperty: vi.fn((name: string) => {
        const value = properties.get(name) ?? "";
        properties.delete(name);
        return value;
      }),
    },
    properties,
  };
}

describe("desktop ui font", () => {
  it("字号收敛到步进刻度并夹取范围", () => {
    expect(clampUiFontSize(14)).toBe(14);
    expect(clampUiFontSize(14.3)).toBe(14.5);
    expect(clampUiFontSize(14.2)).toBe(14);
    expect(clampUiFontSize(1)).toBe(UI_FONT_SIZE_MIN);
    expect(clampUiFontSize(99)).toBe(UI_FONT_SIZE_MAX);
    expect(clampUiFontSize(Number.NaN)).toBe(UI_FONT_SIZE_DEFAULT);
  });

  it("解析持久化字号并兼容早期档位名", () => {
    expect(parseUiFontSize("17.5")).toBe(17.5);
    expect(parseUiFontSize("small")).toBe(12);
    expect(parseUiFontSize("default")).toBe(UI_FONT_SIZE_DEFAULT);
    expect(parseUiFontSize("large")).toBe(16);
    expect(parseUiFontSize("x-large")).toBe(18);
    expect(parseUiFontSize("unknown")).toBe(UI_FONT_SIZE_DEFAULT);
    expect(parseUiFontSize(null)).toBe(UI_FONT_SIZE_DEFAULT);
  });

  it("清洗字体族输入并限制长度", () => {
    expect(sanitizeUiFontFamily(null)).toBe("");
    expect(sanitizeUiFontFamily("  LXGW WenKai  ")).toBe("LXGW WenKai");
    expect(sanitizeUiFontFamily('"PingFang SC", sans-serif')).toBe('"PingFang SC", sans-serif');
    expect(sanitizeUiFontFamily("Fira Sans; background: red }{")).toBe("Fira Sans background: red");
    expect(sanitizeUiFontFamily("Fira\u0000\u001fSans\u007f")).toBe("FiraSans");
    expect(sanitizeUiFontFamily(`${"a".repeat(UI_FONT_FAMILY_MAX_LENGTH)}bcd`)).toHaveLength(UI_FONT_FAMILY_MAX_LENGTH);
  });

  it("字体与字号各自只写入一个 CSS 变量", () => {
    const root = createRoot();

    applyUiFontPreferences(root, { fontFamily: "LXGW WenKai", fontSize: 17.5 });

    expect(root.properties.get(UI_FONT_FAMILY_PROPERTY)).toBe("LXGW WenKai");
    expect(root.properties.get(UI_FONT_SIZE_PROPERTY)).toBe("17.5px");
  });

  it("默认偏好移除变量并回到 CSS 回退值", () => {
    const root = createRoot();

    applyUiFontPreferences(root, { fontFamily: "LXGW WenKai", fontSize: 18 });
    applyUiFontPreferences(root, { fontFamily: "", fontSize: UI_FONT_SIZE_DEFAULT });

    expect(root.style.removeProperty).toHaveBeenCalledWith(UI_FONT_FAMILY_PROPERTY);
    expect(root.style.removeProperty).toHaveBeenCalledWith(UI_FONT_SIZE_PROPERTY);
    expect(root.properties.size).toBe(0);
  });

  it("在 React 启动前恢复偏好并应用到根节点", () => {
    const root = createRoot();

    const preferences = initializeUiFontPreferences({
      root,
      readStoredFontFamily: () => "  Sarasa UI SC  ",
      readStoredFontSize: () => "18",
    });

    expect(preferences).toEqual({ fontFamily: "Sarasa UI SC", fontSize: 18 });
    expect(root.properties.get(UI_FONT_FAMILY_PROPERTY)).toBe("Sarasa UI SC");
    expect(root.properties.get(UI_FONT_SIZE_PROPERTY)).toBe("18px");
  });

  it("持久化不可用时回退到默认偏好", () => {
    const throwingReader = () => {
      throw new Error("storage unavailable");
    };
    const throwingWriter = () => {
      throw new Error("storage unavailable");
    };
    expect(readStoredUiFontFamily(throwingReader)).toBe("");
    expect(readStoredUiFontSize(throwingReader)).toBe(UI_FONT_SIZE_DEFAULT);
    expect(() => writeStoredUiFontFamily("LXGW WenKai", throwingWriter)).not.toThrow();
    expect(() => writeStoredUiFontSize(18, throwingWriter)).not.toThrow();
  });

  it("字号以字符串持久化", () => {
    const writes: string[] = [];
    writeStoredUiFontSize(17.5, (value) => writes.push(value));
    expect(writes).toEqual(["17.5"]);
  });
});
