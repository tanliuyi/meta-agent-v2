import { readFileSync } from "node:fs";
import React, { type ButtonHTMLAttributes, forwardRef, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { CachedSessionRecord } from "../src/renderer/src/runtime/pi-session-store.ts";
import type { DesktopState } from "../src/renderer/src/state/desktop-model.ts";

const testState = vi.hoisted(() => ({
  records: [] as CachedSessionRecord[],
  activeKey: null as string | null,
  desktop: {
    projects: [],
    activeProjectId: null,
    threadCatalogs: {},
    loading: false,
    error: null,
  } as DesktopState,
  openDraft: vi.fn(),
  openSession: vi.fn(),
  retire: vi.fn(),
}));

vi.mock("../src/renderer/src/state/session-cache-context.tsx", () => ({
  useSessionCache: () => ({ retire: testState.retire }),
  useSessionCacheRecords: () => testState.records,
  useSessionCacheActiveKey: () => testState.activeKey,
}));

vi.mock("../src/renderer/src/state/desktop-context.tsx", () => ({
  useDesktopSelector: (selector: (state: DesktopState) => unknown) => selector(testState.desktop),
}));

vi.mock("../src/renderer/src/state/session-navigation.ts", () => ({
  useSessionNavigation: () => ({ openDraft: testState.openDraft, openSession: testState.openSession }),
}));

vi.mock("../src/renderer/src/state/layout.tsx", () => ({
  useLayout: () => ({ sidebarOpen: true, toggleSidebar: vi.fn() }),
}));

vi.mock("../src/renderer/src/state/keyboard-shortcut-provider.tsx", () => ({
  useKeyboardShortcuts: () => ({ getBindings: () => [] }),
}));

vi.mock("../src/renderer/src/components/assistant-ui/tooltip-icon-button.tsx", () => ({
  TooltipIconButton: forwardRef<
    HTMLButtonElement,
    ButtonHTMLAttributes<HTMLButtonElement> & { children?: ReactNode; side?: string; tooltip?: string }
  >(function MockTooltipIconButton({ children, side: _side, tooltip: _tooltip, ...props }, ref) {
    return (
      <button ref={ref} type="button" {...props}>
        {children}
      </button>
    );
  }),
}));

vi.stubGlobal("window", { desktop: { platform: "win32", sessions: { close: vi.fn() } } });

import { SidebarToggle } from "../src/renderer/src/components/layout/sidebar-toggle.tsx";
import { shouldShowWindowsSessionNavigation } from "../src/renderer/src/components/layout/windows-header.tsx";
import {
  moveWindowsSessionTab,
  nextWindowsSessionTab,
  resolveWindowsSessionTabStatus,
  type WindowsSessionTab,
  WindowsSessionTabs,
} from "../src/renderer/src/components/layout/windows-session-tabs.tsx";
import { createSessionRecord } from "../src/renderer/src/runtime/pi-session-store.ts";

const layoutCss = readFileSync(new URL("../src/renderer/src/styles/layout.css", import.meta.url), "utf8");

function setupSessions(): void {
  const first = createSessionRecord({ projectId: "project-a", threadId: "thread-a" });
  const second = createSessionRecord({ projectId: "project-b", threadId: "thread-b" });
  testState.records = [first, second];
  testState.activeKey = first.key;
  testState.desktop = {
    projects: [],
    activeProjectId: "project-a",
    threadCatalogs: {
      "project-a": [
        {
          id: "thread-a",
          projectId: "project-a",
          title: "Active session",
          createdAt: 1,
          updatedAt: 2,
          messageCount: 1,
          preview: "",
          archived: false,
          running: true,
        },
      ],
      "project-b": [
        {
          id: "thread-b",
          projectId: "project-b",
          title: "Second session",
          createdAt: 1,
          updatedAt: 2,
          messageCount: 1,
          preview: "",
          archived: false,
          running: false,
          completed: true,
        },
      ],
    },
    loading: false,
    error: null,
  };
}

describe("WindowsSessionTabs", () => {
  it("renders cached sessions with catalog titles and active state", () => {
    setupSessions();

    const markup = renderToStaticMarkup(<WindowsSessionTabs />);

    expect(markup).toContain('aria-label="已打开的会话"');
    expect(markup).toMatch(/role="tab" aria-selected="true"[^>]*>.*aria-label="运行中".*Active session<\/span>/s);
    expect(markup).toMatch(/role="tab" aria-selected="false"[^>]*>.*aria-label="运行已完成".*Second session<\/span>/s);
    expect(markup).toContain('aria-label="关闭 Active session"');
    expect(markup).toMatch(/class="[^"]*windows-session-tab-close[^"]*size-5!/);
    expect(markup).toContain('aria-label="关闭 Second session"');
    expect(markup).toContain('aria-label="新建任务"');
    expect(markup.indexOf('aria-label="新建任务"')).toBeGreaterThan(markup.indexOf('aria-label="关闭 Second session"'));
    expect(markup.match(/data-tab-index=/g)).toHaveLength(2);
    expect(markup).not.toContain('draggable="true"');
  });

  it("reorders dragged tabs and chooses the visual neighbor when closing", () => {
    const tabs: WindowsSessionTab[] = ["a", "b", "c"].map((key) => ({
      key,
      projectId: "project",
      threadId: key,
      title: key,
      status: "idle",
    }));

    expect(
      moveWindowsSessionTab(
        tabs.map(({ key }) => key),
        "a",
        2,
      ),
    ).toEqual(["b", "c", "a"]);
    expect(
      moveWindowsSessionTab(
        tabs.map(({ key }) => key),
        "c",
        0,
      ),
    ).toEqual(["c", "a", "b"]);
    expect(nextWindowsSessionTab(tabs, 1)?.key).toBe("c");
    expect(nextWindowsSessionTab(tabs, 2)?.key).toBe("b");
  });

  it("prioritizes blocked, running, error, and completed-unread states", () => {
    expect(
      resolveWindowsSessionTabStatus({ blocked: true, running: true, error: true, completed: true, active: false }),
    ).toBe("blocked");
    expect(
      resolveWindowsSessionTabStatus({ blocked: false, running: true, error: true, completed: true, active: false }),
    ).toBe("running");
    expect(
      resolveWindowsSessionTabStatus({ blocked: false, running: false, error: true, completed: true, active: false }),
    ).toBe("error");
    expect(
      resolveWindowsSessionTabStatus({ blocked: false, running: false, error: false, completed: true, active: false }),
    ).toBe("completed");
    expect(
      resolveWindowsSessionTabStatus({ blocked: false, running: false, error: false, completed: true, active: true }),
    ).toBe("idle");
  });

  it("shows the new-task button before a session is opened", () => {
    testState.records = [];
    testState.activeKey = null;
    testState.desktop = { ...testState.desktop, threadCatalogs: {} };

    const markup = renderToStaticMarkup(<WindowsSessionTabs />);

    expect(markup).toContain('aria-label="已打开的会话"');
    expect(markup).toContain('aria-label="新建任务"');
    expect(markup).toMatch(/class="[^"]*windows-session-tabs-new[^"]*size-6!/);
    expect(markup).not.toContain('role="tab"');
  });

  it("hides session navigation throughout settings routes", () => {
    expect(shouldShowWindowsSessionNavigation("/settings")).toBe(false);
    expect(shouldShowWindowsSessionNavigation("/settings/personalization")).toBe(false);
    expect(shouldShowWindowsSessionNavigation("/projects/project-a/session/thread-a")).toBe(true);
  });

  it("keeps the window-header sidebar toggle in the flex layout", () => {
    const headerMarkup = renderToStaticMarkup(<SidebarToggle location="window-header" />);
    const sidebarMarkup = renderToStaticMarkup(<SidebarToggle location="sidebar" />);

    expect(headerMarkup).toContain("shrink-0");
    expect(headerMarkup).not.toMatch(/class="[^"]*\bfixed\b/);
    expect(sidebarMarkup).toMatch(/class="[^"]*\bfixed\b/);
  });

  it("reserves space for the sidebar toggle and keeps tabs interactive inside the draggable header", () => {
    expect(layoutCss).toMatch(/\.windows-header-title\s*\{[^}]*app-region:\s*drag;/s);
    expect(layoutCss).toMatch(/\.windows-header-title\s*>\s*\.sidebar-toggle\s*\{[^}]*flex:\s*0 0 24px;/s);
    expect(layoutCss).toMatch(/\.windows-session-tabs\s*\{[^}]*app-region:\s*no-drag;/s);
    expect(layoutCss).toMatch(
      /\.windows-session-tabs\s*\{[^}]*max-width:\s*calc\(100% - 32px\);[^}]*flex:\s*0 1 auto;/s,
    );
    expect(layoutCss).toMatch(/\.windows-session-tabs-list\s*\{[^}]*width:\s*max-content;[^}]*max-width:\s*100%;/s);
    expect(layoutCss).toMatch(/\.windows-session-tabs-list\s*\{[^}]*position:\s*relative;/s);
    expect(layoutCss).toMatch(/\.windows-session-tabs-list\s*\{[^}]*overflow-x:\s*auto;/s);
    expect(layoutCss).toMatch(/\.windows-session-tabs-new\.windows-session-tabs-new\s*\{[^}]*app-region:\s*no-drag;/s);
    expect(layoutCss).toMatch(/\.windows-session-tabs-new\.windows-session-tabs-new\s*\{[^}]*flex:\s*0 0 24px;/s);
    expect(layoutCss).toMatch(
      /\.windows-session-tabs-new\.windows-session-tabs-new:hover\s*\{[^}]*background:\s*hsl\(var\(--foreground\) \/ 0\.1\);/s,
    );
    expect(layoutCss).not.toMatch(/\.windows-session-tabs-new\.windows-session-tabs-new\s*\{[^}]*background:/s);
    expect(layoutCss).toMatch(
      /\.windows-session-tab-close\.windows-session-tab-close\s*\{[^}]*flex:\s*0 0 20px;[^}]*padding:\s*0;[^}]*margin-inline-end:\s*4px;[^}]*border-radius:\s*var\(--shape-radius-round\);/s,
    );
    expect(layoutCss).toMatch(/\.windows-session-tab-status-blocked\s*\{[^}]*var\(--warning\)/s);
    expect(layoutCss).toMatch(/\.windows-session-tab-status-error\s*\{[^}]*var\(--destructive\)/s);
    expect(layoutCss).toMatch(/\.windows-session-tab-status-completed\s*\{[^}]*var\(--info\)/s);
    expect(layoutCss).not.toMatch(/\.windows-session-tab\[data-dragging="true"\]\s*\{[^}]*opacity:/s);
  });
});
