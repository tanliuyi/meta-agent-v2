import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TooltipIconButton } from "../src/renderer/src/components/assistant-ui/tooltip-icon-button.tsx";
import { TooltipProvider } from "../src/renderer/src/shared/ui/tooltip-provider.tsx";

function renderButtonClass(size?: "icon" | "sm"): string {
  const markup = renderToStaticMarkup(
    <TooltipProvider>
      <TooltipIconButton tooltip="测试" size={size}>
        <span>图标</span>
      </TooltipIconButton>
    </TooltipProvider>,
  );
  const match = markup.match(/class="([^"]+)"/);
  if (match === null) throw new Error("渲染结果缺少 class 属性");
  return match[1];
}

function hasClass(className: string, token: string): boolean {
  return className.split(" ").includes(token);
}

describe("TooltipIconButton", () => {
  it("默认与显式 size=icon：追加 size-6 p-1，保持 24x24 图标按钮视觉", () => {
    for (const rendered of [renderButtonClass(undefined), renderButtonClass("icon")]) {
      expect(hasClass(rendered, "size-6")).toBe(true);
      expect(hasClass(rendered, "p-1")).toBe(true);
      expect(hasClass(rendered, "aui-button-icon")).toBe(true);
      expect(hasClass(rendered, "active:scale-90")).toBe(true);
    }
  });

  it("size=sm：不残留固定 width（无 size-6/p-1），可被调用方紧凑 utility 自由合并", () => {
    const rendered = renderButtonClass("sm");
    expect(hasClass(rendered, "size-6")).toBe(false);
    expect(hasClass(rendered, "p-1")).toBe(false);
    // sm 自带尺寸类保留，供调用方 className 以 twMerge 消除冲突
    expect(hasClass(rendered, "h-(--control-height-button-sm)")).toBe(true);
    expect(hasClass(rendered, "px-3")).toBe(true);
  });
});
