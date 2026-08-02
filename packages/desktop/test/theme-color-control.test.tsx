import React, { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeColorControl } from "../src/renderer/src/features/settings/theme-color-control.tsx";

const themeState = vi.hoisted(() => ({
  resolvedTheme: "light" as "light" | "dark",
  colorPreference: "blue" as "blue" | "teal" | "violet" | "rose" | "amber" | "custom",
  customColor: "#123456",
}));

vi.mock("../src/renderer/src/state/theme.tsx", () => ({
  useTheme: () => ({
    ...themeState,
    setColorPreference: vi.fn(),
    setCustomColor: vi.fn(),
  }),
}));

vi.mock("@radix-ui/react-radio-group", () => ({
  Root: ({ children, ...props }: { children?: ReactNode }) => <div {...props}>{children}</div>,
  Item: ({ children, value, ...props }: { children?: ReactNode; value: string }) => (
    <button type="button" data-value={value} {...props}>
      {children}
    </button>
  ),
}));

describe("ThemeColorControl", () => {
  beforeEach(() => {
    themeState.colorPreference = "blue";
  });

  it("展示预设主题色与自定义入口", () => {
    const html = renderToStaticMarkup(<ThemeColorControl />);

    expect(html).toContain("海蓝");
    expect(html).toContain("青碧");
    expect(html).toContain("紫藤");
    expect(html).toContain("玫红");
    expect(html).toContain("琥珀");
    expect(html).toContain("自定");
    expect(html).not.toContain('aria-label="自定义主题色"');
  });

  it("选择自定义主题色时展示 shadcn 调色板入口", () => {
    themeState.colorPreference = "custom";

    const html = renderToStaticMarkup(<ThemeColorControl />);

    expect(html).toContain('aria-label="自定义主题色"');
    expect(html).toContain("#123456");
    expect(html).not.toContain('type="color"');
  });
});
