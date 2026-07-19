import { describe, expect, it } from "vitest";
import { isSameTerminalGrid } from "../src/renderer/src/components/panel/terminal-view.tsx";
import { limitSize } from "../src/renderer/src/shared/hooks/use-resizable-region.ts";

describe("limitSize", () => {
  it("限制在最小值和最大值之间", () => {
    expect(limitSize(120, 160, 600)).toBe(160);
    expect(limitSize(420.4, 160, 600)).toBe(420);
    expect(limitSize(900, 160, 600)).toBe(600);
  });

  it("视口过小时仍保留可用的最小值", () => {
    expect(limitSize(200, 360, 240)).toBe(360);
  });
});

describe("isSameTerminalGrid", () => {
  it("仅在终端网格行列变化时要求同步", () => {
    expect(isSameTerminalGrid(undefined, { columns: 80, rows: 24 })).toBe(false);
    expect(isSameTerminalGrid({ columns: 80, rows: 24 }, { columns: 80, rows: 24 })).toBe(true);
    expect(isSameTerminalGrid({ columns: 80, rows: 24 }, { columns: 81, rows: 24 })).toBe(false);
    expect(isSameTerminalGrid({ columns: 80, rows: 24 }, { columns: 80, rows: 25 })).toBe(false);
  });
});
