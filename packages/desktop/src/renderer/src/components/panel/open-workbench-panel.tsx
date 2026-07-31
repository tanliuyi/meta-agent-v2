import * as Tabs from "@radix-ui/react-tabs";
import { useResizableRegion } from "@renderer/shared/hooks/use-resizable-region";
import { Button } from "@renderer/shared/ui/button";
import Bot from "lucide-react/dist/esm/icons/bot.mjs";
import Files from "lucide-react/dist/esm/icons/files.mjs";
import ListTodo from "lucide-react/dist/esm/icons/list-todo.mjs";
import MessageSquare from "lucide-react/dist/esm/icons/message-square.mjs";
import Plus from "lucide-react/dist/esm/icons/plus.mjs";
import TerminalSquare from "lucide-react/dist/esm/icons/square-terminal.mjs";
import X from "lucide-react/dist/esm/icons/x.mjs";
import type { CSSProperties } from "react";
import type { SidebarSessionTab } from "../../state/sidebar-session-context.tsx";
import { TooltipIconButton } from "../assistant-ui/tooltip-icon-button.tsx";
import { useSessionScope } from "../session-context.tsx";
import { FilePanel } from "./file-panel.tsx";
import { isWorkbenchPanelValue, type WorkbenchPanelValue } from "./panel-model.ts";
import { PanelTab } from "./panel-tab.tsx";
import { SidebarNewSessionDraft } from "./sidebar-new-session-draft.tsx";
import { SidebarSessionContent } from "./sidebar-session-content.tsx";
import { TaskPanel } from "./task-panel.tsx";
import { TerminalPanel } from "./terminal-panel.tsx";

interface OpenWorkbenchPanelProps {
  open: boolean;
  width: number;
  panel: WorkbenchPanelValue;
  /** 窗口级侧边栏会话 tab 列表；未提供时面板退化为固定 tab。 */
  subagentTabs?: readonly SidebarSessionTab[];
  activeSubagentKey?: string | null;
  onActivateSubagent?(key: string | null): void;
  onCloseSubagentTab?(tab: SidebarSessionTab): void;
  /** 新建 Panel 内容模式。 */
  newPanel?: "closed" | "default" | "draft";
  onOpenNewPanel?(): void;
  onStartNewDraft?(): void;
}

const getPanelMaxSize = () => Math.min(window.innerWidth * 0.68, window.innerWidth * 0.5);
const EMPTY_SUBAGENT_TABS: readonly SidebarSessionTab[] = [];
/** 侧边栏会话 tab 激活时的哨兵 value：不选中任何固定 tab，点击任一固定 tab 都会触发切换。 */
const SUBAGENT_TAB_SENTINEL_VALUE = "__subagent-session__";

/** 渲染已打开的可调整 Workbench，并由 Radix Tabs 管理 tab/tabpanel 语义。 */
export function OpenWorkbenchPanel({
  open,
  width,
  panel,
  subagentTabs = EMPTY_SUBAGENT_TABS,
  activeSubagentKey = null,
  onActivateSubagent = () => undefined,
  onCloseSubagentTab = () => undefined,
  newPanel = "closed",
  onOpenNewPanel = () => undefined,
  onStartNewDraft = () => undefined,
}: OpenWorkbenchPanelProps) {
  const { updateWorkbench } = useSessionScope();
  const resize = useResizableRegion<HTMLDivElement>({
    value: width,
    min: 360,
    getMaxSize: getPanelMaxSize,
    direction: -1,
    orientation: "vertical",
    onCommit: (panelWidth) => updateWorkbench({ panelWidth }),
  });
  const activeSubagentTab = subagentTabs.find((tab) => tab.key === activeSubagentKey) ?? null;

  return (
    <Tabs.Root
      ref={resize.regionRef}
      className="workbench-panel"
      style={{ "--resizable-region-size": `${resize.initialSize}px` } as CSSProperties}
      value={activeSubagentTab ? SUBAGENT_TAB_SENTINEL_VALUE : panel}
      data-collapsed={!open || undefined}
      aria-hidden={!open}
      orientation="horizontal"
      role="complementary"
      aria-label="工作台 Panel"
      onValueChange={(value) => {
        if (isWorkbenchPanelValue(value)) {
          // 切换到固定 tab 时取消 subagent tab 的选中态。
          if (activeSubagentKey !== null) onActivateSubagent(null);
          updateWorkbench({ panel: value });
        }
      }}
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
            <Tabs.List className="panel-tab-list" aria-label="工作台视图">
              <PanelTab value="terminal" label="终端" icon={<TerminalSquare size={14} />} />
              <PanelTab value="files" label="资源管理" icon={<Files size={14} />} />
              <PanelTab value="tasks" label="侧边任务" icon={<ListTodo size={14} />} />
            </Tabs.List>
            {subagentTabs.length > 0 ? (
              <div className="panel-sidebar-tabs" aria-label="侧边栏会话">
                {subagentTabs.map((tab) => (
                  <div
                    key={tab.key}
                    className="panel-sidebar-tab"
                    data-active={tab.key === activeSubagentKey || undefined}
                    title={tab.agentName ?? tab.displayName}
                  >
                    {tab.agentName ? (
                      <Bot className="size-3.5 shrink-0" aria-hidden="true" />
                    ) : (
                      <MessageSquare className="size-3.5 shrink-0" aria-hidden="true" />
                    )}
                    <button
                      type="button"
                      className="panel-sidebar-tab-trigger"
                      aria-pressed={tab.key === activeSubagentKey}
                      onClick={() => onActivateSubagent(tab.key)}
                    >
                      <span>{tab.displayName}</span>
                    </button>
                    <button
                      type="button"
                      className="panel-sidebar-tab-close"
                      aria-label={`关闭 ${tab.displayName}`}
                      onClick={() => onCloseSubagentTab(tab)}
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            <TooltipIconButton
              tooltip="新建 Panel"
              aria-label="新建 Panel"
              className="panel-add"
              data-active={newPanel !== "closed" || undefined}
              aria-pressed={newPanel !== "closed"}
              onClick={onOpenNewPanel}
            >
              <Plus size={14} />
            </TooltipIconButton>
          </header>
          <div id="workbench-panel-content" className="panel-content-stack">
            {newPanel !== "closed" ? (
              newPanel === "draft" ? (
                <SidebarNewSessionDraft />
              ) : (
                <div className="panel-content sidebar-new-panel-default">
                  <button type="button" className="sidebar-new-session-option" onClick={onStartNewDraft}>
                    <Plus className="size-4" aria-hidden="true" />
                    <span>新会话</span>
                  </button>
                </div>
              )
            ) : activeSubagentTab ? (
              <SidebarSessionContent tab={activeSubagentTab} onClose={onCloseSubagentTab} />
            ) : (
              <>
                <Tabs.Content className="panel-content" value="files">
                  <FilePanel />
                </Tabs.Content>
                <Tabs.Content className="panel-content" value="terminal">
                  <TerminalPanel />
                </Tabs.Content>
                <Tabs.Content className="panel-content" value="tasks">
                  <TaskPanel />
                </Tabs.Content>
              </>
            )}
          </div>
        </>
      ) : null}
    </Tabs.Root>
  );
}
