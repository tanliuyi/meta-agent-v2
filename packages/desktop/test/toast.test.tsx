import { readFileSync } from "node:fs";
import React, { Children, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Toast } from "../src/renderer/src/shared/ui/toast.tsx";
import { ToastProvider } from "../src/renderer/src/shared/ui/toast-provider.tsx";
import { ToastViewport } from "../src/renderer/src/shared/ui/toast-viewport.tsx";

describe("Toast", () => {
  it("configures Radix toast tone, content, action, and viewport", () => {
    const element = Toast({
      open: true,
      title: "操作完成",
      message: "插件已重新加载",
      tone: "success",
      action: { label: "查看", altText: "查看插件", onClick: vi.fn() },
      onDismiss: vi.fn(),
    }) as ReactElement<{ "data-tone": string; open: boolean; children: React.ReactNode }>;
    const children = Children.toArray(element.props.children) as ReactElement<{ children?: React.ReactNode }>[];
    const content = children[0];
    const action = children[1];

    expect(element.props["data-tone"]).toBe("success");
    expect(element.props.open).toBe(true);
    expect(Children.toArray(content?.props.children).map((child) => (child as ReactElement).props.children)).toEqual([
      "操作完成",
      "插件已重新加载",
    ]);
    expect(action?.props.children).toBe("查看");

    const viewport = renderToStaticMarkup(
      <ToastProvider label="测试通知">
        <ToastViewport />
      </ToastProvider>,
    );
    expect(viewport).toContain('class="toast-viewport"');
    expect(viewport).toContain("通知 (F8)");
  });

  it("auto-closes within five seconds even when a longer duration is requested", () => {
    const element = Toast({
      open: true,
      message: "正在重新加载",
      duration: 60_000,
      onDismiss: vi.fn(),
    }) as ReactElement<{ duration: number }>;

    expect(element.props.duration).toBe(5_000);
  });

  it("positions the opaque compact toast below the centered title area", () => {
    const css = readFileSync(new URL("../src/renderer/src/styles/components.css", import.meta.url), "utf8");

    expect(css).toContain("left: 50%");
    expect(css).toContain("transform: translateX(-50%)");
    expect(css).toContain("top: calc(var(--layout-topbar-height) + 8px)");
    expect(css).toContain("top: calc(var(--layout-window-header-height) + var(--layout-topbar-height) + 8px)");
    expect(css).toContain("width: min(360px, calc(100vw - 24px))");
    expect(css).toContain("min-height: 36px");
    expect(css).toContain("position: relative");
    expect(css).toContain("padding: var(--space-3) 36px var(--space-3) var(--space-4)");
    expect(css).toContain("transform-origin: top center");
    expect(css).toContain("animation: toast-enter 240ms cubic-bezier(0.16, 1, 0.3, 1)");
    expect(css).toContain("animation: toast-exit 120ms cubic-bezier(0.4, 0, 1, 1)");
    expect(css).toContain("transform: translateY(-14px) scale(0.97)");
    expect(css).toContain("transform: translateY(2px) scale(1)");
    expect(css).toContain("background: hsl(var(--popover))");
    expect(css).toContain("background: color-mix(in oklab, hsl(var(--destructive)) 8%, hsl(var(--popover)))");
    expect(css).toMatch(/\.toast-close \{[\s\S]*?position: absolute;[\s\S]*?top: 8px;[\s\S]*?right: 8px;/);
    expect(css).toContain("border-radius: var(--shape-radius-lg)");
    expect(css).not.toContain("border-left-color");
    expect(css).not.toContain(".toast-icon");
  });
});
