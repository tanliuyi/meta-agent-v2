import { describe, expect, it, vi } from "vitest";
import {
  getSidebarMaxWidth,
  normalizeSidebarWidth,
  parseSidebarWidth,
  readStoredSidebarWidth,
  SIDEBAR_DEFAULT_WIDTH,
  writeStoredSidebarWidth,
} from "../src/renderer/src/state/layout-preference.ts";

describe("sidebar width preference", () => {
  it("解析并限制持久化宽度", () => {
    expect(parseSidebarWidth(null)).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(parseSidebarWidth("invalid")).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(parseSidebarWidth("180")).toBe(220);
    expect(parseSidebarWidth("312.6")).toBe(313);
    expect(parseSidebarWidth("600")).toBe(420);
  });

  it("为常规和紧凑视口计算最大宽度", () => {
    expect(getSidebarMaxWidth(1000)).toBe(236);
    expect(getSidebarMaxWidth(1200)).toBe(420);
    expect(getSidebarMaxWidth(800)).toBe(236);
  });

  it("存储不可用时保留当前交互能力", () => {
    expect(
      readStoredSidebarWidth(() => {
        throw new Error("storage unavailable");
      }),
    ).toBe(SIDEBAR_DEFAULT_WIDTH);

    expect(() =>
      writeStoredSidebarWidth(300, () => {
        throw new Error("storage unavailable");
      }),
    ).not.toThrow();
  });

  it("持久化规范化后的共享宽度", () => {
    const writeValue = vi.fn();
    writeStoredSidebarWidth(500, writeValue);
    expect(writeValue).toHaveBeenCalledWith("420");
    expect(normalizeSidebarWidth(279.5)).toBe(280);
  });
});
