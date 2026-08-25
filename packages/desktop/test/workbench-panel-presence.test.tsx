import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { OpenWorkbenchPanel } from "../src/renderer/src/components/panel/open-workbench-panel.tsx";
import { TooltipProvider } from "../src/renderer/src/shared/ui/tooltip-provider.tsx";
import { registerWorkbenchPanelTab } from "../src/renderer/src/state/panel-tab-registry.ts";
import type { WorkbenchTab } from "../src/shared/contracts.ts";

vi.mock("@renderer/shared/hooks/use-resizable-region", () => ({
  useResizableRegion: () => ({
    regionRef: { current: null },
    separatorRef: { current: null },
    initialSize: 420,
    initialMax: 760,
    onPointerDown: vi.fn(),
    onKeyDown: vi.fn(),
  }),
}));
vi.mock("../src/renderer/src/components/panel/files/file-panel.tsx", () => ({
  FilePanel: () => <div data-slot="files" />,
}));
vi.mock("../src/renderer/src/components/panel/terminal/terminal-view.tsx", () => ({
  TerminalView: () => <div data-slot="terminal" />,
}));
vi.mock("../src/renderer/src/components/panel/session/session-content.tsx", () => ({
  SessionContent: () => <div data-slot="sidebar-session" />,
}));
vi.mock("../src/renderer/src/components/panel/session/new-session-draft.tsx", () => ({
  NewSessionDraft: () => <div data-slot="draft" />,
}));
vi.mock("../src/renderer/src/components/session-context.tsx", () => ({
  useSessionScope: () => ({ updateWorkbench: vi.fn(), record: { key: "session-key" } }),
  useSessionWorkbench: () => null,
  useSessionWorkbenchTabs: () => ({
    tabs: [],
    activeKey: null,
    openSessionTab: vi.fn(),
    openPanelTab: vi.fn(),
    activate: vi.fn(),
    closeTab: vi.fn(),
    openNewPanel: vi.fn(),
  }),
}));
vi.mock("../src/renderer/src/state/session-cache-context.tsx", () => ({
  useSessionCache: () => ({ get: () => undefined }),
}));
vi.mock("../src/renderer/src/state/desktop-store-context.tsx", () => ({
  useDesktopStore: () => ({}),
}));
vi.mock("../src/renderer/src/state/desktop-context.tsx", () => ({
  useDesktopSelector: () => undefined,
}));

const baseProps = {
  tabs: [] as WorkbenchTab[],
  activeKey: null,
  onActivate: vi.fn(),
  onCloseTab: vi.fn(),
  onOpenNewPanel: vi.fn(),
  onOpenPanelTab: vi.fn(),
};

describe("OpenWorkbenchPanel presence", () => {
  it("keeps only an inert collapsed shell when closed", () => {
    const markup = renderToStaticMarkup(
      React.createElement(OpenWorkbenchPanel, { ...baseProps, open: false, width: 420 }),
    );

    expect(markup).toContain('class="workbench-panel"');
    expect(markup).toContain('data-collapsed="true"');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).not.toContain("panel-tabs");
    expect(markup).not.toContain("workbench-panel-content");
    expect(markup).not.toContain("调整右侧 Panel 宽度");
  });

  it("mounts the resize control, tabs, and content when open", () => {
    const markup = renderToStaticMarkup(
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(OpenWorkbenchPanel, { ...baseProps, open: true, width: 420 }),
      ),
    );

    expect(markup).not.toContain("data-collapsed");
    expect(markup).toContain("调整右侧 Panel 宽度");
    expect(markup).toContain("panel-tabs");
    expect(markup).toContain('id="workbench-panel-content"');
  });

  it("renders every registered tab with a close button", () => {
    const markup = renderToStaticMarkup(
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(OpenWorkbenchPanel, {
          ...baseProps,
          open: true,
          width: 420,
          tabs: [
            { kind: "panel", panel: "files" },
            { kind: "terminal", key: "terminal:1", terminalId: "terminal-1", displayName: "终端" },
            { kind: "session", key: "s1", projectId: "p", threadId: "t1", displayName: "执行者", agentName: "worker" },
          ],
          activeKey: "terminal:1",
        }),
      ),
    );

    expect(markup).toContain('data-slot="terminal"');
    expect(markup).toContain("资源管理");
    expect(markup).toContain("终端");
    expect(markup).toContain("执行者");
    expect(markup).toContain("关闭 资源管理");
    expect(markup).toContain("关闭 终端");
    expect(markup).toContain("关闭 执行者");
    expect(markup).toContain('aria-selected="true"');
    expect(markup).toContain('data-active="true"');
  });

  it("renders the session tab content when a session tab is active", () => {
    const markup = renderToStaticMarkup(
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(OpenWorkbenchPanel, {
          ...baseProps,
          open: true,
          width: 420,
          tabs: [
            { kind: "session", key: "s1", projectId: "p", threadId: "t1", displayName: "执行者", agentName: "worker" },
          ],
          activeKey: "s1",
        }),
      ),
    );

    expect(markup).toContain('data-slot="sidebar-session"');
  });

  it("shows the new-panel options from the registry when no tab is registered", () => {
    const markup = renderToStaticMarkup(
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(OpenWorkbenchPanel, { ...baseProps, open: true, width: 420 }),
      ),
    );

    expect(markup).toContain("新会话");
    expect(markup).toContain("资源管理");
    expect(markup).toContain("终端");
    // 未选中任何 tab 时缺省页即当前视图，新建 Panel 按钮呈按下态。
    expect(markup).toContain('data-active="true"');
    expect(markup).toContain('aria-pressed="true"');
  });

  it("renders a registered extension panel through the registry", () => {
    const unregister = registerWorkbenchPanelTab({
      kind: "custom-extension",
      label: "自定义面板",
      icon: null,
      component: () => <div data-slot="custom-extension" />,
      order: 99,
    });
    try {
      const markup = renderToStaticMarkup(
        React.createElement(
          TooltipProvider,
          null,
          React.createElement(OpenWorkbenchPanel, {
            ...baseProps,
            open: true,
            width: 420,
            tabs: [{ kind: "panel", panel: "custom-extension" }],
            activeKey: "panel:custom-extension",
          }),
        ),
      );

      expect(markup).toContain('data-slot="custom-extension"');
      expect(markup).toContain("自定义面板");
      expect(markup).toContain("关闭 自定义面板");
    } finally {
      unregister();
    }
  });

  it("renders the draft through the registered new-session panel kind", () => {
    const markup = renderToStaticMarkup(
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(OpenWorkbenchPanel, {
          ...baseProps,
          open: true,
          width: 420,
          tabs: [{ kind: "panel", panel: "draft" }],
          activeKey: "panel:draft",
        }),
      ),
    );

    expect(markup).toContain('data-slot="draft"');
    expect(markup).toContain("关闭 新会话");
  });

  it("falls back to the kind label for an unregistered panel tab", () => {
    const markup = renderToStaticMarkup(
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(OpenWorkbenchPanel, {
          ...baseProps,
          open: true,
          width: 420,
          tabs: [{ kind: "panel", panel: "gone-extension" }],
          activeKey: "panel:gone-extension",
        }),
      ),
    );

    expect(markup).toContain("面板未注册：gone-extension");
    expect(markup).toContain("关闭 gone-extension");
  });

  it("renders the fullscreen toggle after the new-panel button when wired", () => {
    const markup = renderToStaticMarkup(
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(OpenWorkbenchPanel, {
          ...baseProps,
          open: true,
          width: 420,
          fullscreen: false,
          onToggleFullscreen: () => {},
        }),
      ),
    );

    expect(markup.indexOf("新建 Panel")).toBeGreaterThan(-1);
    expect(markup.indexOf("进入全屏")).toBeGreaterThan(markup.indexOf("新建 Panel"));
    expect(markup).toMatch(/lucide-maximize[^\"]*size-3\.5!/);
  });

  it("reflects the fullscreen state on the panel tab bar button", () => {
    const markup = renderToStaticMarkup(
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(OpenWorkbenchPanel, {
          ...baseProps,
          open: true,
          width: 420,
          fullscreen: true,
          onToggleFullscreen: () => {},
        }),
      ),
    );

    expect(markup).toContain("退出全屏");
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toMatch(/lucide-minimize[^\"]*size-3\.5!/);
  });
});
