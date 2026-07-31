import { describe, expect, it, vi } from "vitest";
import {
  getSidebarMaxWidth,
  normalizeSidebarWidth,
  parseSidebarOpen,
  parseSidebarWidth,
  readStoredSidebarOpen,
  readStoredSidebarWidth,
  SIDEBAR_DEFAULT_OPEN,
  SIDEBAR_DEFAULT_WIDTH,
  writeStoredSidebarOpen,
  writeStoredSidebarWidth,
} from "../src/renderer/src/state/layout-preference.ts";

describe("sidebar open preference", () => {
  it("解析并持久化收起/展开状态", () => {
    expect(parseSidebarOpen(null)).toBe(SIDEBAR_DEFAULT_OPEN);
    expect(parseSidebarOpen("")).toBe(SIDEBAR_DEFAULT_OPEN);
    expect(parseSidebarOpen("1")).toBe(true);
    expect(parseSidebarOpen("0")).toBe(false);
    expect(parseSidebarOpen("invalid")).toBe(false);
  });

  it("存储不可用时保留默认展开状态", () => {
    expect(
      readStoredSidebarOpen(() => {
        throw new Error("storage unavailable");
      }),
    ).toBe(SIDEBAR_DEFAULT_OPEN);

    expect(() =>
      writeStoredSidebarOpen(false, () => {
        throw new Error("storage unavailable");
      }),
    ).not.toThrow();
  });

  it("以 1/0 形式写入收起/展开状态", () => {
    const writeValue = vi.fn();
    writeStoredSidebarOpen(true, writeValue);
    expect(writeValue).toHaveBeenCalledWith("1");
    writeStoredSidebarOpen(false, writeValue);
    expect(writeValue).toHaveBeenCalledWith("0");
  });
});

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
