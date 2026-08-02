import { describe, expect, it, vi } from "vitest";
import { applyMessageWidth, MESSAGE_WIDTH_PROPERTY } from "../src/renderer/src/state/message-width-preference.ts";
import {
  clampMessageWidth,
  MESSAGE_WIDTH_DEFAULT,
  MESSAGE_WIDTH_MAX,
  MESSAGE_WIDTH_MIN,
} from "../src/shared/settings-config-contracts.ts";

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

describe("desktop message width", () => {
  it("宽度收敛到步进刻度并夹取范围", () => {
    expect(clampMessageWidth(810)).toBe(810);
    expect(clampMessageWidth(815)).toBe(820);
    expect(clampMessageWidth(814)).toBe(810);
    expect(clampMessageWidth(1)).toBe(MESSAGE_WIDTH_MIN);
    expect(clampMessageWidth(99999)).toBe(MESSAGE_WIDTH_MAX);
    expect(clampMessageWidth(Number.NaN)).toBe(MESSAGE_WIDTH_DEFAULT);
  });

  it("非默认宽度只写入一个 CSS 变量", () => {
    const root = createRoot();

    applyMessageWidth(root, 960);

    expect(root.properties.get(MESSAGE_WIDTH_PROPERTY)).toBe("960px");
  });

  it("满屏写入 none 取消宽度限制", () => {
    const root = createRoot();

    applyMessageWidth(root, null);

    expect(root.properties.get(MESSAGE_WIDTH_PROPERTY)).toBe("none");
  });

  it("默认宽度移除变量并回到 CSS 回退值", () => {
    const root = createRoot();

    applyMessageWidth(root, 960);
    applyMessageWidth(root, MESSAGE_WIDTH_DEFAULT);

    expect(root.style.removeProperty).toHaveBeenCalledWith(MESSAGE_WIDTH_PROPERTY);
    expect(root.properties.size).toBe(0);
  });
});
