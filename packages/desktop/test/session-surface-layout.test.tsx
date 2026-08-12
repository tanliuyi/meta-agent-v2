import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionSurface } from "../src/renderer/src/components/session-surface.tsx";
import { TooltipProvider } from "../src/renderer/src/shared/ui/tooltip-provider.tsx";

const { chatThreadRenderCount } = vi.hoisted(() => ({ chatThreadRenderCount: { value: 0 } }));

vi.mock("../src/renderer/src/components/chat/chat-thread.tsx", () => ({
  ChatThread: () => {
    chatThreadRenderCount.value += 1;
    return <div data-slot="messages" />;
  },
}));
vi.mock("../src/renderer/src/components/layout/topbar.tsx", () => ({
  Topbar: () => <header data-slot="topbar" />,
}));
vi.mock("../src/renderer/src/components/panel/terminal/bottom-terminal.tsx", () => ({
  BottomTerminal: () => <section data-slot="bottom" />,
}));
vi.mock("../src/renderer/src/components/panel/workbench-panel.tsx", () => ({
  WorkbenchPanel: () => <aside data-slot="panel" />,
}));
vi.mock("../src/renderer/src/components/session-context.tsx", () => ({
  useSessionScope: () => ({ record: { key: "session-1" }, active: true }),
}));
// 用结构替身替代真实 Radix Portal（SSR 下 portal 返回 null，无法断言内容）。
vi.mock("@assistant-ui/react", () => ({
  AssistantModalPrimitive: {
    Root: ({ open, children }: { open?: boolean; children?: React.ReactNode }) => (
      <div data-modal-root data-open={String(open)}>
        {children}
      </div>
    ),
    Anchor: ({ children }: { children?: React.ReactNode }) => <div data-modal-anchor>{children}</div>,
    Trigger: ({ children }: { children?: React.ReactNode }) => (
      <button type="button" data-modal-trigger>
        {children}
      </button>
    ),
    Content: ({ children }: { children?: React.ReactNode }) => <div data-modal-content>{children}</div>,
  },
}));

const renderFullscreen = () =>
  renderToStaticMarkup(
    React.createElement(TooltipProvider, null, React.createElement(SessionSurface, { initialFullscreen: true })),
  );

describe("SessionSurface layout", () => {
  beforeEach(() => {
    chatThreadRenderCount.value = 0;
  });

  it("groups the topbar and session row before the terminal and workbench", () => {
    const markup = renderToStaticMarkup(React.createElement(SessionSurface));

    expect(markup).toContain(
      '<div class="session-surface-shell"><header data-slot="topbar"></header><div class="workspace-row session-surface" data-session-key="session-1" data-active="true"><main class="chat-workspace"><div data-slot="messages"></div></main></div></div><section data-slot="bottom"></section><aside data-slot="panel"></aside>',
    );
    // 普通态：ChatThread 唯一实例，不渲染 modal。
    expect(chatThreadRenderCount.value).toBe(1);
    expect(markup).not.toContain("data-modal-root");
  });

  it("renders the session thread inside the assistant modal when fullscreen", () => {
    const markup = renderFullscreen();

    // 普通会话壳让位，ChatThread 移入 modal Content 且仍为单实例。
    expect(markup).not.toContain('class="chat-workspace"');
    expect(markup).toContain("data-modal-anchor");
    expect(markup).toContain("data-modal-trigger");
    expect(markup).toContain('data-modal-content="true"');
    expect(markup).toContain('<div data-modal-content="true"><div data-slot="messages"></div></div>');
    expect(markup.match(/data-slot="messages"/g)).toHaveLength(1);
    expect(chatThreadRenderCount.value).toBe(1);
  });

  it("does not auto-open the modal when entering fullscreen", () => {
    const markup = renderFullscreen();

    expect(markup).toContain("data-modal-root");
    expect(markup).toContain('data-open="false"');
  });
});
