import { describe, expect, it, vi } from "vitest";
import {
  applyTerminalPreferences,
  clampTerminalFontSize,
  initializeTerminalPreferences,
  parseTerminalFontSize,
  readStoredTerminalFontFamily,
  readStoredTerminalFontSize,
  TERMINAL_FONT_FAMILY_PROPERTY,
  TERMINAL_FONT_SIZE_DEFAULT,
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  TERMINAL_FONT_SIZE_PROPERTY,
  writeStoredTerminalFontFamily,
  writeStoredTerminalFontSize,
} from "../src/renderer/src/state/terminal-preference.ts";

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

describe("desktop terminal font", () => {
  it("字号收敛到步进刻度并夹取范围", () => {
    expect(clampTerminalFontSize(13)).toBe(13);
    expect(clampTerminalFontSize(13.3)).toBe(13.5);
    expect(clampTerminalFontSize(13.2)).toBe(13);
    expect(clampTerminalFontSize(1)).toBe(TERMINAL_FONT_SIZE_MIN);
    expect(clampTerminalFontSize(99)).toBe(TERMINAL_FONT_SIZE_MAX);
    expect(clampTerminalFontSize(Number.NaN)).toBe(TERMINAL_FONT_SIZE_DEFAULT);
  });

  it("解析持久化字号，非有限值回落默认", () => {
    expect(parseTerminalFontSize("15.5")).toBe(15.5);
    expect(parseTerminalFontSize("unknown")).toBe(TERMINAL_FONT_SIZE_DEFAULT);
    expect(parseTerminalFontSize(null)).toBe(TERMINAL_FONT_SIZE_DEFAULT);
  });

  it("清洗终端字体族输入并限制长度", () => {
    expect(readStoredTerminalFontFamily(() => "  Fira Code  ")).toBe("Fira Code");
    expect(readStoredTerminalFontFamily(() => "Fira Code; background: red }{")).toBe("Fira Code background: red");
    expect(readStoredTerminalFontFamily(() => null)).toBe("");
  });

  it("字体与字号各自只写入一个 CSS 变量", () => {
    const root = createRoot();

    applyTerminalPreferences(root, { fontFamily: "Fira Code", fontSize: 15.5 });

    expect(root.properties.get(TERMINAL_FONT_FAMILY_PROPERTY)).toBe("Fira Code");
    expect(root.properties.get(TERMINAL_FONT_SIZE_PROPERTY)).toBe("15.5px");
  });

  it("默认偏好移除变量并回到 CSS 回退值", () => {
    const root = createRoot();

    applyTerminalPreferences(root, { fontFamily: "Fira Code", fontSize: 18 });
    applyTerminalPreferences(root, { fontFamily: "", fontSize: TERMINAL_FONT_SIZE_DEFAULT });

    expect(root.style.removeProperty).toHaveBeenCalledWith(TERMINAL_FONT_FAMILY_PROPERTY);
    expect(root.style.removeProperty).toHaveBeenCalledWith(TERMINAL_FONT_SIZE_PROPERTY);
    expect(root.properties.size).toBe(0);
  });

  it("在 React 启动前恢复偏好并应用到根节点", () => {
    const root = createRoot();

    const preferences = initializeTerminalPreferences({
      root,
      readStoredFontFamily: () => "  JetBrains Mono  ",
      readStoredFontSize: () => "16",
    });

    expect(preferences).toEqual({ fontFamily: "JetBrains Mono", fontSize: 16 });
    expect(root.properties.get(TERMINAL_FONT_FAMILY_PROPERTY)).toBe("JetBrains Mono");
    expect(root.properties.get(TERMINAL_FONT_SIZE_PROPERTY)).toBe("16px");
  });

  it("持久化不可用时回退到默认偏好", () => {
    const throwingReader = () => {
      throw new Error("storage unavailable");
    };
    const throwingWriter = () => {
      throw new Error("storage unavailable");
    };
    expect(readStoredTerminalFontFamily(throwingReader)).toBe("");
    expect(readStoredTerminalFontSize(throwingReader)).toBe(TERMINAL_FONT_SIZE_DEFAULT);
    expect(() => writeStoredTerminalFontFamily("Fira Code", throwingWriter)).not.toThrow();
    expect(() => writeStoredTerminalFontSize(16, throwingWriter)).not.toThrow();
  });

  it("字号以字符串持久化", () => {
    const writes: string[] = [];
    writeStoredTerminalFontSize(15.5, (value) => writes.push(value));
    expect(writes).toEqual(["15.5"]);
  });
});
