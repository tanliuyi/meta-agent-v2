import type { WorkbenchSessionTab } from "../../../shared/contracts.ts";
import { sessionRecordKey } from "../runtime/pi-session-store.ts";
import { builtinSubagentDisplayName } from "../shared/lib/builtin-subagent-name.ts";
import { type DesktopStore, dispatchDesktop } from "./desktop-store.ts";
import type { SessionCacheController } from "./session-cache-context.tsx";

/** 可在侧边栏（workbench panel）中打开的会话目标。 */
export interface ThreadSidebarTarget {
  projectId: string;
  threadId: string;
  title: string;
  agentName?: string;
}

export interface OpenThreadSidebarDeps {
  /** 会话绑定到 activeSessionKey 的 openSessionTab（单参形式）。 */
  workbenchTabs: { openSessionTab(tab: WorkbenchSessionTab): void };
  cache: SessionCacheController;
  store: DesktopStore;
  /** 承载侧边栏 tab 的活动主 session。 */
  activeSessionKey: string;
}

/**
 * 在活动主 session 的侧边栏（workbench panel）中打开会话 tab，并展开 panel。
 * 调用方需先确认目标 thread 属于活动主 session（自身或其子/孙，见 isThreadDescendantOf）。
 * `panelWidth` 仅由未打开 panel 的拖拽落点传入，用于复用视觉占位宽度。
 */
export function openThreadAsSidebarTab(
  deps: OpenThreadSidebarDeps,
  thread: ThreadSidebarTarget,
  panelWidth?: number,
): void {
  const { workbenchTabs, cache, store, activeSessionKey } = deps;
  workbenchTabs.openSessionTab({
    kind: "session",
    key: sessionRecordKey(thread.projectId, thread.threadId),
    projectId: thread.projectId,
    threadId: thread.threadId,
    agentName: thread.agentName,
    displayName: thread.agentName ? builtinSubagentDisplayName(thread.agentName) : thread.title || "新会话",
  });
  dispatchDesktop(store, { type: "thread-viewed", projectId: thread.projectId, threadId: thread.threadId });
  const record = cache.get(activeSessionKey);
  const workbench = record?.stores.workbench.getSnapshot();
  if (record && workbench) {
    const next = {
      ...workbench,
      panelOpen: true,
      ...(panelWidth === undefined ? {} : { panelWidth }),
    };
    record.stores.workbench.replace(next);
    void window.desktop.workbench.update(next);
  }
}
