import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { OpenWorkbenchPanel } from "../src/renderer/src/components/panel/open-workbench-panel.tsx";
import { TooltipProvider } from "../src/renderer/src/shared/ui/tooltip-provider.tsx";

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
vi.mock("../src/renderer/src/components/panel/file-panel.tsx", () => ({
  FilePanel: () => <div data-slot="files" />,
}));
vi.mock("../src/renderer/src/components/panel/task-panel.tsx", () => ({
  TaskPanel: () => <div data-slot="tasks" />,
}));
vi.mock("../src/renderer/src/components/panel/terminal-panel.tsx", () => ({
  TerminalPanel: () => <div data-slot="terminal" />,
}));
vi.mock("../src/renderer/src/components/panel/sidebar-session-content.tsx", () => ({
  SidebarSessionContent: () => <div data-slot="sidebar-session" />,
}));
vi.mock("../src/renderer/src/components/panel/sidebar-new-session-draft.tsx", () => ({
  SidebarNewSessionDraft: () => <div data-slot="draft" />,
}));
vi.mock("../src/renderer/src/components/session-context.tsx", () => ({
  useSessionScope: () => ({ updateWorkbench: vi.fn() }),
  useSessionWorkbench: () => null,
}));

describe("OpenWorkbenchPanel presence", () => {
  it("keeps only an inert collapsed shell when closed", () => {
    const markup = renderToStaticMarkup(
      React.createElement(OpenWorkbenchPanel, { open: false, width: 420, panel: "files" }),
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
        React.createElement(OpenWorkbenchPanel, { open: true, width: 420, panel: "files" }),
      ),
    );

    expect(markup).not.toContain("data-collapsed");
    expect(markup).toContain("调整右侧 Panel 宽度");
    expect(markup).toContain("panel-tabs");
    expect(markup).toContain('id="workbench-panel-content"');
  });

  it("renders the subagent session without selecting any fixed tab", () => {
    const markup = renderToStaticMarkup(
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(OpenWorkbenchPanel, {
          open: true,
          width: 420,
          panel: "files",
          subagentTabs: [{ key: "s1", projectId: "p", threadId: "t1", displayName: "执行者", agentName: "worker" }],
          activeSubagentKey: "s1",
        }),
      ),
    );

    expect(markup).toContain('data-slot="sidebar-session"');
    expect(markup).not.toContain('data-state="active"');
    expect(markup).toContain('aria-pressed="true"');
  });
});
