import { describe, expect, it } from "vitest";
import { isSameTerminalGrid } from "../src/renderer/src/components/panel/terminal/terminal-view.tsx";
import { limitSize, resolveDragStartSize } from "../src/renderer/src/shared/hooks/use-resizable-region.ts";

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

describe("resolveDragStartSize", () => {
  it("优先使用实际渲染尺寸（展开动画中间值或外部压缩后的显示宽度）", () => {
    // 展开动画进行到一半、内部 ref 仍是目标宽度 280 时，起点应取渲染值。
    expect(resolveDragStartSize(240, 280, 220, 420)).toBe(240);
    // 右侧 Panel 被 CSS max-width 压缩时，起点应取被压缩后的显示宽度。
    expect(resolveDragStartSize(480, 576, 360, 480)).toBe(480);
  });

  it("渲染尺寸超出限制范围时按限制收敛", () => {
    expect(resolveDragStartSize(80, 280, 220, 420)).toBe(220);
    expect(resolveDragStartSize(900, 280, 220, 420)).toBe(420);
  });

  it("渲染尺寸无效或为零时回退内部当前尺寸", () => {
    // 收起状态元素宽度为 0（手柄此时也不可交互，仅作防御）。
    expect(resolveDragStartSize(0, 280, 220, 420)).toBe(280);
    expect(resolveDragStartSize(Number.NaN, 280, 220, 420)).toBe(280);
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
