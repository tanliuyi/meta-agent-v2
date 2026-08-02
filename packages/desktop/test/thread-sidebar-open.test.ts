import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionRecord } from "../src/renderer/src/runtime/pi-session-store.ts";
import { createDesktopStore } from "../src/renderer/src/state/desktop-store.ts";
import type { SessionCacheController } from "../src/renderer/src/state/session-cache-context.tsx";
import { openThreadAsSidebarTab, type ThreadSidebarTarget } from "../src/renderer/src/state/thread-sidebar-open.ts";
import type { WorkbenchSessionTab } from "../src/shared/contracts.ts";

const activeKey = "active\u0000main";

function activeRecord(panelOpen: boolean) {
  const record = createSessionRecord({ projectId: "active", threadId: "main" });
  record.stores.workbench.replace({ projectId: "active", threadId: "main", panelOpen, panelWidth: 480 });
  return record;
}

function stubWindowDesktop() {
  const update = vi.fn();
  Object.defineProperty(globalThis, "window", {
    value: { desktop: { workbench: { update } } },
    configurable: true,
    writable: true,
  });
  return update;
}

/** 侧边栏会话打开逻辑：供拖拽落点与“在侧边栏打开”右键共用。 */
describe("openThreadAsSidebarTab", () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).window;
  });

  it("不限父/祖先关系，在活动主 session 的 workbench tab 中注册会话并选中", () => {
    stubWindowDesktop();
    const opened: WorkbenchSessionTab[] = [];
    const thread: ThreadSidebarTarget = {
      projectId: "other",
      threadId: "child",
      title: "检查渲染树",
      agentName: "reviewer",
    };
    openThreadAsSidebarTab(
      {
        workbenchTabs: { openSessionTab: (tab) => opened.push(tab) },
        cache: { get: () => activeRecord(false) } as unknown as SessionCacheController,
        store: createDesktopStore(),
        activeSessionKey: activeKey,
      },
      thread,
    );

    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({
      kind: "session",
      key: "other\u0000child",
      projectId: "other",
      threadId: "child",
      agentName: "reviewer",
      displayName: "审查员",
    });
  });

  it("普通会话使用标题作为 tab 展示名", () => {
    stubWindowDesktop();
    const opened: WorkbenchSessionTab[] = [];
    openThreadAsSidebarTab(
      {
        workbenchTabs: { openSessionTab: (tab) => opened.push(tab) },
        cache: { get: () => activeRecord(false) } as unknown as SessionCacheController,
        store: createDesktopStore(),
        activeSessionKey: activeKey,
      },
      { projectId: "active", threadId: "sibling", title: "并行任务" },
    );

    expect(opened[0]?.displayName).toBe("并行任务");
  });

  it("panel 未打开时使用视觉占位宽度展开，并持久化到 workbench 存储", () => {
    const update = stubWindowDesktop();
    const record = activeRecord(false);
    openThreadAsSidebarTab(
      {
        workbenchTabs: { openSessionTab: () => undefined },
        cache: { get: () => record } as unknown as SessionCacheController,
        store: createDesktopStore(),
        activeSessionKey: activeKey,
      },
      { projectId: "active", threadId: "child", title: "子会话" },
      720,
    );

    const workbench = record.stores.workbench.getSnapshot();
    expect(workbench?.panelOpen).toBe(true);
    expect(workbench?.panelWidth).toBe(720);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ panelOpen: true, panelWidth: 720 }));
  });

  it("未提供视觉占位宽度时保留原有面板宽度", () => {
    stubWindowDesktop();
    const record = activeRecord(false);
    openThreadAsSidebarTab(
      {
        workbenchTabs: { openSessionTab: () => undefined },
        cache: { get: () => record } as unknown as SessionCacheController,
        store: createDesktopStore(),
        activeSessionKey: activeKey,
      },
      { projectId: "active", threadId: "child", title: "子会话" },
    );

    expect(record.stores.workbench.getSnapshot()?.panelWidth).toBe(480);
  });
});
