import { readFileSync } from "node:fs";
import React, { type ButtonHTMLAttributes, forwardRef, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { CachedSessionRecord } from "../src/renderer/src/runtime/pi-session-store.ts";
import { detachedSnapshot } from "../src/renderer/src/runtime/pi-thread-store.ts";
import type { DesktopState } from "../src/renderer/src/state/desktop-model.ts";
import type { SessionControlState } from "../src/shared/contracts.ts";
import { PROTOCOL_VERSION } from "../src/shared/contracts.ts";

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
  useKeyboardShortcuts: () => ({
    getBindings: (commandId: string) => {
      const index = Number(commandId.at(-1));
      return Number.isInteger(index) ? [{ modifiers: ["mod"], key: String(index) }] : [];
    },
    primaryModifierPressed: false,
    registerCommandHandler: () => () => undefined,
  }),
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

import { shouldShowDesktopSessionNavigation } from "../src/renderer/src/components/layout/desktop-header.tsx";
import {
  type DesktopSessionTab,
  DesktopSessionTabs,
  moveDesktopSessionTab,
  nextDesktopSessionTab,
  resolveDesktopSessionTabStatus,
} from "../src/renderer/src/components/layout/desktop-session-tabs.tsx";
import { SidebarToggle } from "../src/renderer/src/components/layout/sidebar-toggle.tsx";
import { createSessionRecord } from "../src/renderer/src/runtime/pi-session-store.ts";

const mainSource = readFileSync(new URL("../src/main/index.ts", import.meta.url), "utf8");
const layoutCss = readFileSync(new URL("../src/renderer/src/styles/layout.css", import.meta.url), "utf8");
const desktopHeaderSource = readFileSync(
  new URL("../src/renderer/src/components/layout/desktop-header.tsx", import.meta.url),
  "utf8",
);
const desktopSessionTabsSource = readFileSync(
  new URL("../src/renderer/src/components/layout/desktop-session-tabs.tsx", import.meta.url),
  "utf8",
);
const keyboardShortcutProviderSource = readFileSync(
  new URL("../src/renderer/src/state/keyboard-shortcut-provider.tsx", import.meta.url),
  "utf8",
);
const desktopWindowTitleSource = readFileSync(
  new URL("../src/renderer/src/app/desktop-window-title.tsx", import.meta.url),
  "utf8",
);

function setupSessions(): void {
  const first = createSessionRecord({ projectId: "project-a", threadId: "thread-a" });
  const second = createSessionRecord({ projectId: "project-b", threadId: "thread-b" });
  const firstTimeline = first.stores.timeline.getSnapshot();
  first.stores.timeline.replace({
    ...firstTimeline,
    projectId: "project-a",
    threadId: "thread-a",
    phase: "running",
  });
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

describe("DesktopSessionTabs", () => {
  it("renders cached sessions with catalog titles and active state", () => {
    setupSessions();

    const markup = renderToStaticMarkup(<DesktopSessionTabs />);

    expect(markup).toContain('aria-label="已打开的会话"');
    expect(markup).toMatch(/role="tab" aria-selected="true"[^>]*>.*aria-label="运行中".*Active session<\/span>/s);
    expect(markup).toMatch(/role="tab" aria-selected="false"[^>]*>.*aria-label="运行已完成".*Second session<\/span>/s);
    expect(markup).toContain('aria-label="关闭 Active session"');
    expect(markup).toMatch(/class="[^"]*desktop-session-tab-close[^"]*size-5!/);
    expect(markup).toContain('aria-label="关闭 Second session"');
    expect(markup).toContain('aria-label="新建任务"');
    expect(markup.indexOf('aria-label="新建任务"')).toBeGreaterThan(markup.indexOf('aria-label="关闭 Second session"'));
    expect(markup.match(/data-tab-index=/g)).toHaveLength(2);
    expect(markup).not.toContain('draggable="true"');
  });

  it("uses the timeline to clear stale running control and catalog state", () => {
    setupSessions();
    const first = testState.records[0]!;
    first.stores.timeline.replace({ ...first.stores.timeline.getSnapshot(), phase: "idle" });
    first.stores.control.replace(sessionControl(true));

    const markup = renderToStaticMarkup(<DesktopSessionTabs />);

    expect(markup).not.toContain('aria-label="运行中"');
  });

  it("uses the catalog completion state when an inactive timeline is stale", () => {
    setupSessions();
    const second = testState.records[1]!;
    second.stores.timeline.replace({
      ...second.stores.timeline.getSnapshot(),
      projectId: "project-b",
      threadId: "thread-b",
      phase: "running",
    });

    const markup = renderToStaticMarkup(<DesktopSessionTabs />);

    expect(markup).toMatch(/role="tab" aria-selected="false"[^>]*>.*aria-label="运行已完成".*Second session<\/span>/s);
  });

  it("falls back to control state before the timeline is attached", () => {
    setupSessions();
    const first = testState.records[0]!;
    first.stores.timeline.replace(detachedSnapshot());
    first.stores.control.replace(sessionControl(true));

    const markup = renderToStaticMarkup(<DesktopSessionTabs />);

    expect(markup).toContain('aria-label="运行中"');
  });

  it("reorders dragged tabs and chooses the visual neighbor when closing", () => {
    const tabs: DesktopSessionTab[] = ["a", "b", "c"].map((key) => ({
      key,
      projectId: "project",
      threadId: key,
      title: key,
      status: "idle",
    }));

    expect(
      moveDesktopSessionTab(
        tabs.map(({ key }) => key),
        "a",
        2,
      ),
    ).toEqual(["b", "c", "a"]);
    expect(
      moveDesktopSessionTab(
        tabs.map(({ key }) => key),
        "c",
        0,
      ),
    ).toEqual(["c", "a", "b"]);
    expect(nextDesktopSessionTab(tabs, 1)?.key).toBe("c");
    expect(nextDesktopSessionTab(tabs, 2)?.key).toBe("b");
  });

  it("prioritizes blocked, running, error, and completed-unread states", () => {
    expect(
      resolveDesktopSessionTabStatus({ blocked: true, running: true, error: true, completed: true, active: false }),
    ).toBe("blocked");
    expect(
      resolveDesktopSessionTabStatus({ blocked: false, running: true, error: true, completed: true, active: false }),
    ).toBe("running");
    expect(
      resolveDesktopSessionTabStatus({ blocked: false, running: false, error: true, completed: true, active: false }),
    ).toBe("error");
    expect(
      resolveDesktopSessionTabStatus({ blocked: false, running: false, error: false, completed: true, active: false }),
    ).toBe("completed");
    expect(
      resolveDesktopSessionTabStatus({ blocked: false, running: false, error: false, completed: true, active: true }),
    ).toBe("idle");
  });

  it("shows the new-task button before a session is opened", () => {
    testState.records = [];
    testState.activeKey = null;
    testState.desktop = { ...testState.desktop, threadCatalogs: {} };

    const markup = renderToStaticMarkup(<DesktopSessionTabs />);

    expect(markup).toContain('aria-label="已打开的会话"');
    expect(markup).toContain('aria-label="新建任务"');
    expect(markup).toMatch(/class="[^"]*desktop-session-tabs-new[^"]*size-6!/);
    expect(markup).not.toContain('role="tab"');
  });

  it("hides session navigation throughout settings routes", () => {
    expect(shouldShowDesktopSessionNavigation("/settings")).toBe(false);
    expect(shouldShowDesktopSessionNavigation("/settings/personalization")).toBe(false);
    expect(shouldShowDesktopSessionNavigation("/projects/project-a/session/thread-a")).toBe(true);
  });

  it("keeps the window-header sidebar toggle in the flex layout", () => {
    const headerMarkup = renderToStaticMarkup(<SidebarToggle location="window-header" />);
    const sidebarMarkup = renderToStaticMarkup(<SidebarToggle location="sidebar" />);

    expect(headerMarkup).toContain("shrink-0");
    expect(headerMarkup).not.toMatch(/class="[^"]*\bfixed\b/);
    expect(sidebarMarkup).toMatch(/class="[^"]*\bfixed\b/);
  });

  it("shares the desktop header while reserving the native macOS traffic lights", () => {
    expect(mainSource).toMatch(/titleBarStyle: process\.platform === "darwin" \? "hiddenInset" : "default"/);
    expect(mainSource).toMatch(
      /trafficLightPosition: process\.platform === "darwin" \? \{ x: 16, y: 12 \} : undefined/,
    );
    expect(desktopWindowTitleSource).toMatch(/platform === "linux" \? null : <DesktopHeader \/>/);
    expect(desktopHeaderSource).toMatch(/platform === "darwin" \? null : \(/);
    expect(layoutCss).toMatch(
      /\.app-frame:is\(\[data-platform="win32"\], \[data-platform="darwin"\]\)\s*\{[^}]*grid-template-rows:\s*var\(--layout-window-header-height\)/s,
    );
    expect(layoutCss).toMatch(
      /\.app-frame\[data-platform="darwin"\] \.desktop-header-title\s*\{[^}]*padding-left:\s*92px;/s,
    );
  });

  it("reserves space for the sidebar toggle and keeps tabs interactive inside the draggable header", () => {
    expect(layoutCss).toMatch(/\.desktop-header-title\s*\{[^}]*app-region:\s*drag;/s);
    expect(layoutCss).toMatch(/\.desktop-header-title\s*>\s*\.sidebar-toggle\s*\{[^}]*flex:\s*0 0 24px;/s);
    expect(layoutCss).toMatch(/\.desktop-session-tabs\s*\{[^}]*app-region:\s*no-drag;/s);
    expect(layoutCss).toMatch(
      /\.desktop-session-tabs\s*\{[^}]*max-width:\s*calc\(100% - 32px\);[^}]*flex:\s*0 1 auto;/s,
    );
    expect(layoutCss).toMatch(/\.desktop-session-tabs-list\s*\{[^}]*width:\s*max-content;[^}]*max-width:\s*100%;/s);
    expect(layoutCss).toMatch(/\.desktop-session-tabs-list\s*\{[^}]*position:\s*relative;/s);
    expect(layoutCss).toMatch(/\.desktop-session-tabs-list\s*\{[^}]*overflow-x:\s*auto;/s);
    expect(layoutCss).toMatch(/\.desktop-session-tabs-new\.desktop-session-tabs-new\s*\{[^}]*app-region:\s*no-drag;/s);
    expect(layoutCss).toMatch(/\.desktop-session-tabs-new\.desktop-session-tabs-new\s*\{[^}]*flex:\s*0 0 24px;/s);
    expect(layoutCss).toMatch(
      /\.desktop-session-tabs-new\.desktop-session-tabs-new:hover\s*\{[^}]*background:\s*hsl\(var\(--foreground\) \/ 0\.1\);/s,
    );
    expect(layoutCss).not.toMatch(/\.desktop-session-tabs-new\.desktop-session-tabs-new\s*\{[^}]*background:/s);
    expect(layoutCss).toMatch(
      /\.desktop-session-tab-close\.desktop-session-tab-close\s*\{[^}]*flex:\s*0 0 20px;[^}]*padding:\s*0;[^}]*margin-inline-end:\s*4px;[^}]*border-radius:\s*var\(--shape-radius-round\);/s,
    );
    expect(layoutCss).toMatch(
      /\.desktop-session-tab-close\.desktop-session-tab-close\[data-shortcut-hint="true"\]\s*\{[^}]*border-radius:\s*var\(--shape-radius-xl\);[^}]*background:\s*hsl\(var\(--shortcut-hint-background\)\);[^}]*color:\s*hsl\(var\(--shortcut-hint-foreground\)\);/s,
    );
    expect(layoutCss).toMatch(
      /\.desktop-session-tab-shortcut-hint,\s*\.desktop-thread-shortcut-hint\s*\{[^}]*font-size:\s*11px;[^}]*font-variant-numeric:\s*tabular-nums;[^}]*font-weight:\s*600;/s,
    );
    expect(layoutCss).toMatch(
      /\.desktop-thread-shortcut-hint\s*\{[^}]*width:\s*20px;[^}]*height:\s*20px;[^}]*border-radius:\s*var\(--shape-radius-xl\);[^}]*background:\s*hsl\(var\(--shortcut-hint-background\)\);/s,
    );
    expect(keyboardShortcutProviderSource).toMatch(/window\.addEventListener\("keydown", onKeyDown\)/);
    expect(keyboardShortcutProviderSource).toMatch(/window\.addEventListener\("keyup", onKeyUp\)/);
    expect(keyboardShortcutProviderSource).toMatch(/window\.addEventListener\("blur", onBlur\)/);
    expect(desktopSessionTabsSource).toMatch(/orderedRecords\.slice\(0, DESKTOP_SESSION_TAB_COMMAND_IDS\.length\)/);
    expect(layoutCss).toMatch(
      /\.desktop-session-tab-status-running\s*\{[^}]*width:\s*12px;[^}]*border-top-color:\s*hsl\(var\(--foreground\)[^}]*animation:\s*spin/s,
    );
    expect(layoutCss).not.toMatch(/\.desktop-session-tab-status-running\s*\{[^}]*var\(--primary\)/s);
    expect(layoutCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*\.desktop-session-tab-status-running\s*\{[^}]*animation:\s*none;/s,
    );
    expect(layoutCss).toMatch(/\.desktop-session-tab-status-blocked\s*\{[^}]*var\(--warning\)/s);
    expect(layoutCss).toMatch(/\.desktop-session-tab-status-error\s*\{[^}]*var\(--destructive\)/s);
    expect(layoutCss).toMatch(/\.desktop-session-tab-status-completed\s*\{[^}]*var\(--info\)/s);
    expect(layoutCss).not.toMatch(/\.desktop-session-tab\[data-dragging="true"\]\s*\{[^}]*opacity:/s);
  });
});

function sessionControl(running: boolean): SessionControlState {
  return {
    protocolVersion: PROTOCOL_VERSION,
    revision: 1,
    projectId: "project-a",
    threadId: "thread-a",
    title: "Active session",
    updatedAt: 2,
    cwd: "/project-a",
    running,
    queueModes: { steering: "all", followUp: "all" },
    models: [],
    commands: [],
    thinkingLevel: "off",
    thinkingLevels: [],
    readiness: { state: "ready" },
    hostRequests: [],
    extensionSet: { generation: "test", diagnostics: [], reloadRequired: false },
    extensionHost: { statuses: {}, widgets: [] },
  };
}
