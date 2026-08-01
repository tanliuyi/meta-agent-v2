import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { FloatingSidebar } from "../src/renderer/src/components/layout/floating-sidebar.tsx";
import { TooltipProvider } from "../src/renderer/src/shared/ui/tooltip-provider.tsx";
import { LayoutProvider } from "../src/renderer/src/state/layout.tsx";
import { SIDEBAR_OPEN_STORAGE_KEY, SIDEBAR_WIDTH_STORAGE_KEY } from "../src/renderer/src/state/layout-preference.ts";

vi.mock("@renderer/shared/hooks/use-resizable-region", () => ({
  useResizableRegion: () => ({
    regionRef: { current: null },
    separatorRef: { current: null },
    initialSize: 280,
    initialMax: 420,
    onPointerDown: vi.fn(),
    onKeyDown: vi.fn(),
  }),
}));

vi.mock("@tanstack/react-router", async () => {
  const ReactModule = await import("react");
  return {
    Link: ({ children, to: _to, search: _search, ...rest }: Record<string, unknown>) =>
      ReactModule.createElement("a", rest, children as React.ReactNode),
    useMatchRoute: () => () => undefined,
    useNavigate: () => vi.fn(),
    useSearch: () => ({}),
  };
});

vi.mock("../src/renderer/src/components/layout/project-list.tsx", () => ({
  ProjectList: () => <div data-slot="projects" />,
}));

vi.mock("../src/renderer/src/components/layout/general-conversation-section.tsx", () => ({
  GeneralConversationSection: () => <div data-slot="general" />,
}));

vi.mock("../src/renderer/src/components/layout/update-banner.tsx", () => ({
  UpdateBanner: () => null,
}));

vi.mock("../src/renderer/src/state/desktop-context.tsx", () => ({
  useDesktopActions: () => ({ chooseProject: vi.fn() }),
}));

vi.mock("../src/renderer/src/state/session-cache-context.tsx", () => ({
  useSessionDraftMaterializing: () => false,
}));

describe("FloatingSidebar", () => {
  it("侧边栏展开时不渲染浮出预览", () => {
    expect(renderSidebar("1")).toBe("");
  });

  it("侧边栏收起时提供窗口左缘触发区与按存储宽度浮出的面板", () => {
    const markup = renderSidebar("0");

    expect(markup).toContain('class="floating-sidebar"');
    expect(markup).toContain('class="floating-sidebar-trigger"');
    expect(markup).toContain('class="floating-sidebar-panel"');
    expect(markup).toContain('style="width:280px"');
    expect(markup).not.toContain('data-open="true"');
    // win32 窗口标题栏下方起始,避免遮挡窗口控制。
    expect(markup).toContain('style="top:var(--layout-window-header-height)"');
  });

  it("浮出面板内复用 Sidebar 并强制展开内容", () => {
    const markup = renderSidebar("0");

    expect(markup).toContain('class="sidebar" data-collapsed="false" data-floating="true"');
    expect(markup).toContain('id="floating-sidebar-content" class="sidebar-content"');
    expect(markup).not.toContain("resize-handle-sidebar");
    // 浮出预览内的展开按钮用于固定侧边栏。
    expect(markup).toContain('aria-label="展开侧边栏"');
  });
});

function renderSidebar(open: "0" | "1"): string {
  vi.stubGlobal("window", {
    desktop: { platform: "win32" },
    localStorage: {
      getItem: (key: string) => {
        if (key === SIDEBAR_OPEN_STORAGE_KEY) return open;
        if (key === SIDEBAR_WIDTH_STORAGE_KEY) return "280";
        return null;
      },
    },
  });

  try {
    return renderToStaticMarkup(
      <LayoutProvider>
        <TooltipProvider>
          <FloatingSidebar />
        </TooltipProvider>
      </LayoutProvider>,
    );
  } finally {
    vi.unstubAllGlobals();
  }
}
