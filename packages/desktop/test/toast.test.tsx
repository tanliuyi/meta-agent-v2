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

  it("positions the compact viewport below the centered title area", () => {
    const css = readFileSync(new URL("../src/renderer/src/styles/components.css", import.meta.url), "utf8");

    expect(css).toContain("left: 50%");
    expect(css).toContain("transform: translateX(-50%)");
    expect(css).toContain("top: calc(var(--layout-topbar-height) + 8px)");
    expect(css).toContain("top: calc(var(--layout-window-header-height) + var(--layout-topbar-height) + 8px)");
    expect(css).toContain("width: min(360px, calc(100vw - 24px))");
    expect(css).toContain("min-height: 36px");
    expect(css).toContain("padding: var(--space-3) var(--space-4)");
    expect(css).toContain("border-radius: var(--shape-radius-lg)");
    expect(css).not.toContain("border-left-color");
    expect(css).not.toContain(".toast-icon");
  });
});
