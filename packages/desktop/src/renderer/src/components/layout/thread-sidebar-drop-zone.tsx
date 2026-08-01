import { useState } from "react";
import { parseSessionRecordKey } from "../../runtime/pi-session-store.ts";
import { useDesktopSelector } from "../../state/desktop-context.tsx";
import { selectProjectThreads } from "../../state/desktop-selectors.ts";
import { useDesktopStore } from "../../state/desktop-store-context.tsx";
import { useSessionCache, useSessionCacheActiveKey } from "../../state/session-cache-context.tsx";
import { THREAD_DRAG_MIME, useThreadDrag } from "../../state/thread-drag-context.tsx";
import { isThreadDescendantOf } from "../../state/thread-list-commands.ts";
import { openThreadAsSidebarTab } from "../../state/thread-sidebar-open.ts";
import { useWorkbenchTabs } from "../../state/workbench-tab-context.tsx";

/**
 * 会话拖拽到侧边栏的落点：渲染在工作区右缘（VS Code 式占位）。
 * 仅当侧边栏（workbench panel）未打开时显示；拖拽会话期间展示蒙层，
 * 悬停时高亮，drop 后在活动主 session 的侧边栏中打开会话 tab 并展开 panel。
 * 仅属于活动主 session（自身或其子/孙）的 thread 可拖入；
 * 侧边栏已打开时由 open-workbench-panel 自身承接 drop，此处不再显示占位。
 */
export function ThreadSidebarDropZone() {
  const { dragged } = useThreadDrag();
  const activeSessionKey = useSessionCacheActiveKey();
  const workbenchTabs = useWorkbenchTabs();
  const cache = useSessionCache();
  const store = useDesktopStore();
  const [over, setOver] = useState(false);
  const activeRecord = activeSessionKey ? cache.get(activeSessionKey) : undefined;
  const panelOpen = activeRecord?.stores.workbench.getSnapshot()?.panelOpen === true;
  const activeIdentity = activeSessionKey ? parseSessionRecordKey(activeSessionKey) : null;
  const activeThreadId = activeIdentity?.threadId ?? null;
  const activeProjectThreads =
    useDesktopSelector((state) =>
      activeIdentity ? selectProjectThreads(state, activeIdentity.projectId) : undefined,
    ) ?? [];
  if (!dragged || panelOpen) return null;

  // 仅属于活动主 session（自身或其子/孙）的 thread 才能拖入本会话侧边栏。
  const canDrop =
    activeSessionKey !== null &&
    activeThreadId !== null &&
    isThreadDescendantOf(activeProjectThreads, dragged.threadId, activeThreadId);
  const acceptsDrag = (types: readonly string[]): boolean => Array.from(types).includes(THREAD_DRAG_MIME);

  return (
    <div
      className="thread-drop-zone"
      data-active={over && canDrop ? true : undefined}
      data-invalid={over && !canDrop ? true : undefined}
      data-drop-zone
      onDragEnter={(event) => {
        if (!canDrop || !acceptsDrag(event.dataTransfer.types)) return;
        event.preventDefault();
        setOver(true);
      }}
      onDragOver={(event) => {
        if (!canDrop || !acceptsDrag(event.dataTransfer.types)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        setOver(false);
        if (!canDrop || !acceptsDrag(event.dataTransfer.types) || activeSessionKey === null) return;
        openThreadAsSidebarTab(
          {
            workbenchTabs: { openSessionTab: (tab) => workbenchTabs.openSessionTab(activeSessionKey, tab) },
            cache,
            store,
            activeSessionKey,
          },
          dragged,
        );
      }}
      onDragEnd={() => setOver(false)}
      aria-hidden="true"
    />
  );
}
