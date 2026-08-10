import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { FloatingSidebar } from "../src/renderer/src/components/layout/floating-sidebar.tsx";
import { TooltipProvider } from "../src/renderer/src/shared/ui/tooltip-provider.tsx";
import { LayoutProvider } from "../src/renderer/src/state/layout.tsx";
import { SIDEBAR_OPEN_STORAGE_KEY, SIDEBAR_WIDTH_STORAGE_KEY } from "../src/renderer/src/state/layout-preference.ts";
import { preferencesStorage } from "../src/renderer/src/state/preferences-store.ts";

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
  useDesktopSelector: (selector: (state: unknown) => unknown) => selector({ projects: [], threadCatalogs: {} }),
}));

vi.mock("../src/renderer/src/state/session-cache-context.tsx", () => ({
  useSessionDraftMaterializing: () => false,
}));

vi.mock("../src/renderer/src/state/draft-session-context.tsx", () => ({
  useDraftSession: () => ({ projectId: null }),
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
    // 面板宽度由拖拽调宽的 CSS 变量驱动,初始值取存储宽度。
    expect(markup).toContain('style="--resizable-region-size:280px"');
    expect(markup).not.toContain('data-open="true"');
  });

  it("浮出面板复用 Sidebar 并强制展开内容,面板右缘提供拖拽调宽手柄", () => {
    const markup = renderSidebar("0");

    expect(markup).toContain('class="sidebar" data-collapsed="false" data-floating="true"');
    expect(markup).toContain('id="floating-sidebar-content" class="sidebar-content"');
    // 浮出面板自身的调宽手柄,与主侧边栏一致的语义属性。
    expect(markup).toContain("resize-handle-sidebar");
    expect(markup).toContain('aria-label="调整侧边栏宽度"');
    expect(markup).toContain('aria-controls="floating-sidebar-content"');
    expect(markup).toContain('aria-valuemin="220"');
    expect(markup).toContain('aria-valuemax="420"');
    expect(markup).toContain('aria-valuenow="280"');
  });
});

function renderSidebar(open: "0" | "1"): string {
  preferencesStorage.reset();
  vi.stubGlobal("window", {
    desktop: {
      platform: "win32",
      preferences: {
        getInitial: () => ({
          path: "preferences.json",
          exists: true,
          values: {
            [SIDEBAR_OPEN_STORAGE_KEY]: open,
            [SIDEBAR_WIDTH_STORAGE_KEY]: "280",
          },
        }),
        save: () => Promise.resolve({ status: "saved" }),
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
