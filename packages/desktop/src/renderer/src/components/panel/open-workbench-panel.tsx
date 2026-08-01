import { useResizableRegion } from "@renderer/shared/hooks/use-resizable-region";
import Plus from "lucide-react/dist/esm/icons/plus.mjs";
import { type CSSProperties, useRef, useState } from "react";
import { parseSessionRecordKey } from "../../runtime/pi-session-store.ts";
import { useDesktopSelector } from "../../state/desktop-context.tsx";
import { selectProjectThreads } from "../../state/desktop-selectors.ts";
import { useDesktopStore } from "../../state/desktop-store-context.tsx";
import { getWorkbenchPanelTabDefinition, useWorkbenchPanelTabs } from "../../state/panel-tab-registry.ts";
import { useSessionCache } from "../../state/session-cache-context.tsx";
import { THREAD_DRAG_MIME, useThreadDrag } from "../../state/thread-drag-context.tsx";
import { isThreadDescendantOf } from "../../state/thread-list-commands.ts";
import { openThreadAsSidebarTab } from "../../state/thread-sidebar-open.ts";
import type { WorkbenchTab, WorkbenchTabState } from "../../state/workbench-tab-context.tsx";
import { workbenchTabKey } from "../../state/workbench-tab-context.tsx";
import { TooltipIconButton } from "../assistant-ui/tooltip-icon-button.tsx";
import { useSessionScope, useSessionWorkbenchTabs } from "../session-context.tsx";
import { registerBuiltinPanelTabs } from "./builtin-panel-tabs.tsx";
import { WorkbenchTabList } from "./panel-tab.tsx";
import { SessionContent } from "./session/session-content.tsx";

// 桌面内置面板在模块加载时注册；扩展面板可随时通过 registerWorkbenchPanelTab 追加。
registerBuiltinPanelTabs();

interface OpenWorkbenchPanelProps extends WorkbenchTabState {
  open: boolean;
  width: number;
  onActivate(key: string | null): void;
  onCloseTab(tab: WorkbenchTab): void;
  onOpenNewPanel(): void;
  onOpenPanelTab(panel: string): void;
}

const getPanelMaxSize = () => Math.min(window.innerWidth * 0.68, window.innerWidth * 0.5);

/**
 * 渲染已打开的可调整 Workbench；tab 全部为动态注册（会话或经注册表面板），均可关闭。
 * 新建缺省页与面板内容均按注册表定义解析，新增面板无需改动本组件。
 */
export function OpenWorkbenchPanel({
  open,
  width,
  tabs,
  activeKey,
  onActivate,
  onCloseTab,
  onOpenNewPanel,
  onOpenPanelTab,
}: OpenWorkbenchPanelProps) {
  const { updateWorkbench, record } = useSessionScope();
  const definitions = useWorkbenchPanelTabs();
  const resize = useResizableRegion<HTMLDivElement>({
    value: width,
    min: 360,
    getMaxSize: getPanelMaxSize,
    direction: -1,
    orientation: "vertical",
    onCommit: (panelWidth) => updateWorkbench({ panelWidth }),
  });
  const activeTab = tabs.find((tab) => workbenchTabKey(tab) === activeKey) ?? null;
  const activeDefinition = activeTab?.kind === "panel" ? getWorkbenchPanelTabDefinition(activeTab.panel) : undefined;
  // 未选中任何 tab 时展示新建缺省页；选项来自注册表中 addable 的面板定义。
  const newPanelOptions = definitions.filter((definition) => definition.addable !== false);

  // 侧边栏已打开时承接会话拖拽：悬停高亮，drop 后将会话作为 tab 打开（不再显示右缘占位条）。
  const { dragged } = useThreadDrag();
  const sessionWorkbenchTabs = useSessionWorkbenchTabs();
  const cache = useSessionCache();
  const store = useDesktopStore();
  const dropDepthRef = useRef(0);
  const [dropOver, setDropOver] = useState(false);
  const activeIdentity = parseSessionRecordKey(record.key);
  const activeThreadId = activeIdentity?.threadId ?? null;
  const activeProjectThreads =
    useDesktopSelector((state) =>
      activeIdentity ? selectProjectThreads(state, activeIdentity.projectId) : undefined,
    ) ?? [];
  // 仅属于活动主 session（自身或其子/孙）的 thread 才能拖入本会话侧边栏。
  const canDrop =
    dragged !== null &&
    activeThreadId !== null &&
    isThreadDescendantOf(activeProjectThreads, dragged.threadId, activeThreadId);
  const acceptsDrag = (types: readonly string[]): boolean => Array.from(types).includes(THREAD_DRAG_MIME);
  const clearDrop = () => {
    dropDepthRef.current = 0;
    setDropOver(false);
  };

  return (
    <div
      ref={resize.regionRef}
      className="workbench-panel"
      style={{ "--resizable-region-size": `${resize.initialSize}px` } as CSSProperties}
      data-collapsed={!open || undefined}
      data-drop-active={dropOver || undefined}
      aria-hidden={!open}
      role="complementary"
      aria-label="工作台 Panel"
      onDragEnter={(event) => {
        if (!canDrop || !acceptsDrag(event.dataTransfer.types)) return;
        event.preventDefault();
        dropDepthRef.current += 1;
        setDropOver(true);
      }}
      onDragOver={(event) => {
        if (!canDrop || !acceptsDrag(event.dataTransfer.types)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setDropOver(true);
      }}
      onDragLeave={() => {
        dropDepthRef.current = Math.max(0, dropDepthRef.current - 1);
        if (dropDepthRef.current === 0) setDropOver(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        clearDrop();
        if (!canDrop || !dragged) return;
        openThreadAsSidebarTab(
          { workbenchTabs: sessionWorkbenchTabs, cache, store, activeSessionKey: record.key },
          dragged,
        );
      }}
      onDragEnd={clearDrop}
    >
      {open ? (
        <>
          <div
            ref={resize.separatorRef}
            className="resize-handle resize-handle-panel"
            role="separator"
            tabIndex={0}
            aria-label="调整右侧 Panel 宽度"
            aria-controls="workbench-panel-content"
            aria-orientation="vertical"
            aria-valuemin={360}
            aria-valuemax={resize.initialMax}
            aria-valuenow={resize.initialSize}
            aria-valuetext={`${resize.initialSize} 像素`}
            onPointerDown={resize.onPointerDown}
            onKeyDown={resize.onKeyDown}
          />
          <header className="panel-tabs">
            <div className="panel-tabs-safe-area" aria-hidden="true" />
            <WorkbenchTabList
              tabs={tabs}
              activeKey={activeTab ? activeKey : null}
              onActivate={onActivate}
              onCloseTab={onCloseTab}
            />
            <TooltipIconButton
              tooltip="新建 Panel"
              aria-label="新建 Panel"
              className="text-muted-foreground"
              data-active={activeKey === null || undefined}
              aria-pressed={activeKey === null}
              onClick={onOpenNewPanel}
            >
              <Plus className="size-4.5!" />
            </TooltipIconButton>
          </header>
          <div
            id="workbench-panel-content"
            className="panel-content-stack"
            role="tabpanel"
            aria-labelledby={activeTab ? `panel-tab-${workbenchTabKey(activeTab)}` : undefined}
          >
            {activeKey === null ? (
              <div className="panel-content sidebar-new-panel-default">
                <div className="sidebar-new-panel-options" aria-label="新建 Panel">
                  {newPanelOptions.map((definition) => (
                    <button
                      key={definition.kind}
                      type="button"
                      className="sidebar-new-session-option"
                      onClick={() => onOpenPanelTab(definition.kind)}
                    >
                      {definition.icon}
                      <span>{definition.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : activeTab?.kind === "session" ? (
              <SessionContent tab={activeTab} onClose={onCloseTab} />
            ) : activeTab?.kind === "panel" && activeDefinition ? (
              <div className="panel-content">
                <activeDefinition.component />
              </div>
            ) : activeTab?.kind === "panel" ? (
              <div className="panel-content sidebar-session-loading">面板未注册：{activeTab.panel}</div>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
