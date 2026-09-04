import { useResizableRegion } from "@renderer/shared/hooks/use-resizable-region";
import Maximize from "lucide-react/dist/esm/icons/maximize.mjs";
import Minimize from "lucide-react/dist/esm/icons/minimize.mjs";
import Plus from "lucide-react/dist/esm/icons/plus.mjs";
import TerminalSquare from "lucide-react/dist/esm/icons/square-terminal.mjs";
import { type CSSProperties, useCallback, useEffect, useRef, useState } from "react";
import type { WorkbenchTab } from "../../../../shared/contracts.ts";
import { parseSessionRecordKey } from "../../runtime/pi-session-store.ts";
import { useDesktopSelector } from "../../state/desktop-context.tsx";
import { selectProjectThreads } from "../../state/desktop-selectors.ts";
import { useDesktopStore } from "../../state/desktop-store-context.tsx";
import { getWorkbenchPanelTabDefinition, useWorkbenchPanelTabs } from "../../state/panel-tab-registry.ts";
import { useSessionCache } from "../../state/session-cache-context.tsx";
import { THREAD_DRAG_MIME, useThreadDrag } from "../../state/thread-drag-context.tsx";
import { isThreadDescendantOf } from "../../state/thread-list-commands.ts";
import { openThreadAsSidebarTab } from "../../state/thread-sidebar-open.ts";
import type { WorkbenchTabState } from "../../state/workbench-tab-context.tsx";
import { workbenchPanelTabKey, workbenchTabKey } from "../../state/workbench-tab-context.tsx";
import { TooltipIconButton } from "../assistant-ui/tooltip-icon-button.tsx";
import { useSessionScope, useSessionWorkbenchTabs } from "../session-context.tsx";
import {
  BROWSER_PANEL_KIND,
  FILES_PANEL_KIND,
  NEW_SESSION_PANEL_KIND,
  PROJECT_PANEL_KIND,
  SCM_PANEL_KIND,
} from "./builtin-panel-kinds.ts";

import { registerBuiltinPanelTabs } from "./builtin-panel-tabs.tsx";
import { WorkbenchTabList } from "./panel-tab.tsx";
import { SessionContent } from "./session/session-content.tsx";
import { TerminalView } from "./terminal/terminal-view.tsx";

// 桌面内置面板在模块加载时注册；扩展面板可随时通过 registerWorkbenchPanelTab 追加。
registerBuiltinPanelTabs();

interface OpenWorkbenchPanelProps extends WorkbenchTabState {
  open: boolean;
  width: number;
  fullscreen?: boolean;
  onToggleFullscreen?: () => void;
  onActivate(key: string | null): void;
  onCloseTab(tab: WorkbenchTab): void;
  onOpenNewPanel(): void;
  onOpenPanelTab(panel: string): void;
}

const getPanelMaxSize = () => {
  const viewportWidth = typeof window === "undefined" ? 0 : window.innerWidth;
  const fallback = Math.max(360, viewportWidth * 0.8);
  if (typeof document === "undefined") return fallback;

  const shell = document.querySelector<HTMLElement>(".session-surface-shell");
  const workspace = shell?.closest<HTMLElement>(".workspace");
  if (!shell || !workspace) return fallback;

  const workspaceWidth = workspace.getBoundingClientRect().width;
  // 窄工作区 Panel 覆盖在聊天区之上，允许占据更大比例；宽工作区限制在 80% 以内。
  const ratio = workspaceWidth < 720 ? 0.92 : 0.8;
  return Math.max(360, workspaceWidth * ratio);
};

// 终端是“一 tab 一终端”的多开 tab（不占用面板注册表），固定在缺省页首位。
// 静态 JSX 提升到模块级，避免每次渲染重建（rendering-hoist-jsx）。
const TERMINAL_OPTION = { kind: "terminal", label: "终端", icon: <TerminalSquare size={14} /> } as const;

/**
 * 渲染已打开的可调整 Workbench；tab 全部为动态注册（会话或经注册表面板），均可关闭。
 * 新建缺省页与面板内容均按注册表定义解析，新增面板无需改动本组件。
 */
export function OpenWorkbenchPanel({
  open,
  width,
  fullscreen = false,
  onToggleFullscreen,
  tabs,
  activeKey,
  onActivate,
  onCloseTab,
  onOpenNewPanel,
  onOpenPanelTab,
}: OpenWorkbenchPanelProps) {
  const { updateWorkbench, record, isDraft } = useSessionScope();
  const definitions = useWorkbenchPanelTabs();
  const [panelMaxSize, setPanelMaxSize] = useState(getPanelMaxSize);
  useEffect(() => {
    const workspace = document.querySelector<HTMLElement>(".workspace");
    if (!workspace) return;
    const updateMaxSize = () => {
      const next = getPanelMaxSize();
      setPanelMaxSize((current) => (current === next ? current : next));
    };
    updateMaxSize();
    const observer = new ResizeObserver(updateMaxSize);
    observer.observe(workspace);
    return () => observer.disconnect();
  }, [open, width]);
  const resize = useResizableRegion<HTMLDivElement>({
    value: width,
    min: 360,
    getMaxSize: getPanelMaxSize,
    direction: -1,
    orientation: "vertical",
    onCommit: (panelWidth) => updateWorkbench({ panelWidth }),
  });
  const activeTab = tabs.find((tab) => workbenchTabKey(tab) === activeKey) ?? null;
  const activeDefinition =
    activeTab?.kind === "panel"
      ? getWorkbenchPanelTabDefinition(
          activeTab.panel === FILES_PANEL_KIND || activeTab.panel === SCM_PANEL_KIND
            ? PROJECT_PANEL_KIND
            : activeTab.panel,
        )
      : undefined;
  const sessionWorkbenchTabs = useSessionWorkbenchTabs();

  /** 新建终端 tab：编号取 workbench state 的单调计数器（跨刷新持久化），id 与主进程 PTY 槽位对齐。 */
  const openNewTerminalTab = useCallback(() => {
    const workbench = record.stores.workbench.getSnapshot();
    const counter = (workbench?.terminalTabCounter ?? 0) + 1;
    updateWorkbench({ terminalTabCounter: counter });
    sessionWorkbenchTabs.openTerminalTab({
      kind: "terminal",
      key: `terminal:${counter}`,
      terminalId: `terminal-${counter}`,
      displayName: counter === 1 ? "终端" : `终端 ${counter}`,
    });
  }, [record, sessionWorkbenchTabs, updateWorkbench]);
  // 未选中任何 tab 时展示新建缺省页；选项来自注册表中 addable 的面板定义。
  // 新会话草稿尚未固定项目，不提供“新会话”草稿面板入口。
  const newPanelOptions = definitions.filter(
    (definition) => definition.addable !== false && !(isDraft && definition.kind === NEW_SESSION_PANEL_KIND),
  );
  // 终端是“一 tab 一终端”的多开 tab（不占用面板注册表），固定在缺省页首位。
  const newPanelOptionsWithTerminal = [TERMINAL_OPTION, ...newPanelOptions];
  // 草稿下即使已打开过“新会话”面板 tab 也隐藏（页面级 tab 表理论上不会出现）。
  const visibleTabs = isDraft
    ? tabs.filter((tab) => workbenchTabKey(tab) !== workbenchPanelTabKey(NEW_SESSION_PANEL_KIND))
    : tabs;

  // 侧边栏已打开时承接会话拖拽：悬停高亮，drop 后将会话作为 tab 打开（不再显示右缘占位条）。
  const { dragged } = useThreadDrag();
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
  const runningThreadIds = new Set(activeProjectThreads.filter(({ running }) => running).map(({ id }) => id));
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
      style={
        {
          "--resizable-region-size": `${resize.initialSize}px`,
          "--workbench-max-size": `${Math.round(panelMaxSize)}px`,
        } as CSSProperties
      }
      data-collapsed={!open || undefined}
      data-fullscreen={fullscreen || undefined}
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
          {
            workbenchTabs: sessionWorkbenchTabs,
            cache,
            store,
            activeSessionKey: record.key,
          },
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
              tabs={visibleTabs}
              activeKey={activeTab ? activeKey : null}
              runningThreadIds={runningThreadIds}
              onActivate={onActivate}
              onCloseTab={onCloseTab}
            />
            <TooltipIconButton
              variant="ghost"
              size="icon"
              tooltip="新建 Panel"
              aria-label="新建 Panel"
              className="panel-add size-6 text-muted-foreground"
              data-active={activeKey === null || undefined}
              aria-pressed={activeKey === null}
              onClick={onOpenNewPanel}
            >
              <Plus className="size-4!" />
            </TooltipIconButton>
            {onToggleFullscreen ? (
              <TooltipIconButton
                variant="ghost"
                size="icon"
                tooltip={fullscreen ? "退出全屏" : "全屏"}
                aria-label={fullscreen ? "退出全屏" : "进入全屏"}
                className="panel-fullscreen size-6 text-muted-foreground"
                aria-pressed={fullscreen}
                onClick={onToggleFullscreen}
              >
                {fullscreen ? <Minimize className="size-3.5!" /> : <Maximize className="size-3.5!" />}
              </TooltipIconButton>
            ) : null}
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
                  {newPanelOptionsWithTerminal.map((option) => (
                    <button
                      key={option.kind}
                      type="button"
                      className="sidebar-new-session-option"
                      onClick={() => (option.kind === "terminal" ? openNewTerminalTab() : onOpenPanelTab(option.kind))}
                    >
                      {option.icon}
                      <span>{option.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : activeTab?.kind === "session" ? (
              <SessionContent tab={activeTab} onClose={onCloseTab} />
            ) : activeTab?.kind === "terminal" || (activeTab?.kind === "panel" && activeTab.panel === "terminal") ? (
              // 终端 tab：一 tab 一终端；兼容旧版本持久化的 panel:terminal tab（terminalId 回退 "panel"）。
              <div className="panel-content">
                <TerminalView terminalId={activeTab.kind === "terminal" ? activeTab.terminalId : "panel"} />
              </div>
            ) : activeTab?.kind === "panel" && activeDefinition ? (
              <div className="panel-content">
                {isDraft && activeTab.panel === BROWSER_PANEL_KIND ? (
                  // 草稿阶段无真实会话（threadId 固定为 draft，多个草稿会共享同一浏览器
                  // runtime）：禁用浏览器面板，提交会话后再使用。
                  <div className="panel-content sidebar-session-loading">
                    浏览器在新建会话草稿阶段不可用，提交会话后即可使用
                  </div>
                ) : (
                  <activeDefinition.component />
                )}
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
