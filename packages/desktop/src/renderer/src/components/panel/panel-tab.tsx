import Bot from "lucide-react/dist/esm/icons/bot.mjs";
import LayoutPanelLeft from "lucide-react/dist/esm/icons/layout-panel-left.mjs";
import MessageSquare from "lucide-react/dist/esm/icons/message-square.mjs";
import TerminalSquare from "lucide-react/dist/esm/icons/square-terminal.mjs";
import X from "lucide-react/dist/esm/icons/x.mjs";
import type { KeyboardEvent, ReactNode } from "react";
import { useRef } from "react";
import type { WorkbenchTab } from "../../../../shared/contracts.ts";
import { getWorkbenchPanelTabDefinition, useWorkbenchPanelTabs } from "../../state/panel-tab-registry.ts";
import { workbenchTabKey } from "../../state/workbench-tab-context.tsx";

interface WorkbenchTabListProps {
  tabs: readonly WorkbenchTab[];
  activeKey: string | null;
  runningThreadIds: ReadonlySet<string>;
  onActivate(key: string | null): void;
  onCloseTab(tab: WorkbenchTab): void;
}

/**
 * workbench-panel 的 tab 条：面板（经注册表解析展示）与会话 tab 统一为可关闭的 pill。
 * 支持方向键/HOME/END 的 roving focus，激活跟随聚焦（与 Radix Tabs 一致）。
 */
export function WorkbenchTabList({ tabs, activeKey, runningThreadIds, onActivate, onCloseTab }: WorkbenchTabListProps) {
  const definitions = useWorkbenchPanelTabs();
  const listRef = useRef<HTMLDivElement>(null);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const triggers = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("[data-tab-trigger]") ?? []);
    if (triggers.length === 0) return;
    const currentIndex =
      document.activeElement instanceof HTMLButtonElement ? triggers.indexOf(document.activeElement) : -1;
    let nextIndex: number;
    switch (event.key) {
      case "ArrowRight":
        nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % triggers.length;
        break;
      case "ArrowLeft":
        nextIndex = currentIndex === -1 ? triggers.length - 1 : (currentIndex - 1 + triggers.length) % triggers.length;
        break;
      case "Home":
        nextIndex = 0;
        break;
      default:
        nextIndex = triggers.length - 1;
        break;
    }
    event.preventDefault();
    triggers[nextIndex]?.focus();
  }

  return (
    <div
      ref={listRef}
      className="panel-tab-list"
      role="tablist"
      aria-label="工作台视图"
      tabIndex={-1}
      onKeyDown={handleKeyDown}
    >
      {tabs.map((tab) => {
        const key = workbenchTabKey(tab);
        const definition = tab.kind === "panel" ? getWorkbenchPanelTabDefinition(tab.panel) : undefined;
        // 未注册的面板回退到注册键本身，保证已打开 tab 始终可见可关闭。
        const label = tab.kind === "panel" ? (definition?.label ?? tab.panel) : tab.displayName;
        const agentRunning = tab.kind === "session" && Boolean(tab.agentName) && runningThreadIds.has(tab.threadId);
        const icon: ReactNode =
          tab.kind === "panel" ? (
            (definition?.icon ?? <LayoutPanelLeft className="size-3.5 shrink-0" aria-hidden="true" />)
          ) : tab.kind === "terminal" ? (
            <TerminalSquare className="size-3.5 shrink-0" aria-hidden="true" />
          ) : tab.agentName ? (
            <span className="panel-tab-agent-icon" data-running={agentRunning || undefined} aria-hidden="true">
              <Bot className="size-3.5" />
            </span>
          ) : (
            <MessageSquare className="size-3.5 shrink-0" aria-hidden="true" />
          );
        const active = key === activeKey;
        return (
          <div key={key} className="panel-tab-item" data-active={active || undefined}>
            <button
              type="button"
              className="panel-tab-trigger"
              data-tab-trigger
              role="tab"
              id={`panel-tab-${key}`}
              aria-selected={active}
              aria-busy={agentRunning || undefined}
              aria-controls="workbench-panel-content"
              tabIndex={active ? 0 : -1}
              onClick={() => onActivate(key)}
              onFocus={() => onActivate(key)}
            >
              {icon}
              <span className="panel-tab-label">{label}</span>
            </button>
            <button
              type="button"
              className="panel-tab-close"
              aria-label={`关闭 ${label}`}
              onClick={() => {
                onCloseTab(tab);
                listRef.current?.focus();
              }}
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
