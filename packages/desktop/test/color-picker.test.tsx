import React, { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ColorPicker, hexToHsv, hsvToHex } from "../src/renderer/src/shared/ui/color-picker.tsx";

vi.mock("@radix-ui/react-popover", () => ({
  Root: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Trigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Content: ({ children, ...props }: { children?: ReactNode }) => <div {...props}>{children}</div>,
}));

describe("ColorPicker", () => {
  it("渲染 shadcn Popover 调色板控件", () => {
    const html = renderToStaticMarkup(<ColorPicker value="#2563EB" onValueChange={vi.fn()} />);

    expect(html).toContain("#2563EB");
    expect(html).toContain('role="slider"');
    expect(html).toContain('aria-label="饱和度与亮度"');
    expect(html).toContain('type="range"');
    expect(html).toContain('aria-label="十六进制颜色"');
    expect(html).not.toContain('type="color"');
  });

  it.each(["#FF0000", "#00FF00", "#0000FF", "#2563EB", "#0F766E", "#FFFFFF", "#000000"])(
    "在 HSV 与 HEX 之间往返 %s",
    (hex) => {
      expect(hsvToHex(hexToHsv(hex))).toBe(hex);
    },
  );

  it("夹取超出范围的 HSV 输入", () => {
    expect(hsvToHex({ hue: 360, saturation: 120, value: 120 })).toBe("#FF0000");
    expect(hsvToHex({ hue: -120, saturation: -10, value: -10 })).toBe("#000000");
  });
});
