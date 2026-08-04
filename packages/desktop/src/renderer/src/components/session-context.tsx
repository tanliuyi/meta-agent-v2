import { createContext, type ReactNode, useCallback, useContext, useMemo } from "react";
import type {
  PiThreadSnapshot,
  SessionBranchResult,
  SessionControlState,
  ThinkingLevel,
  WorkbenchSessionTab,
  WorkbenchState,
} from "../../../shared/contracts.ts";
import type { CachedSessionRecord } from "../runtime/pi-session-store.ts";
import { useExternalStoreSelector } from "../shared/hooks/use-external-store-selector.ts";
import type { SessionWorkbenchTabs } from "../state/workbench-tab-context.tsx";
import { useWorkbenchTabs } from "../state/workbench-tab-context.tsx";
import { FILES_PANEL_KIND } from "./panel/builtin-panel-kinds.ts";
import { openWorkbenchFilePatch } from "./panel/panel-model.ts";

export interface SessionScope {
  record: CachedSessionRecord;
  active: boolean;
  commandsReady: boolean;
  modelsRefreshing: boolean;
  clearQueue(): Promise<void>;
  branch(sourceEntryId: string): Promise<SessionBranchResult>;
  refreshModels(): Promise<void>;
  setModel(provider: string, modelId: string): Promise<void>;
  setThinking(level: ThinkingLevel): Promise<void>;
  updateWorkbench(value: Partial<WorkbenchState>): void;
  /** 未 materialize 的新会话草稿：无 control/connection，workbench 为页面级状态。 */
  isDraft?: boolean;
  /** 草稿模式下的 workbench tab 状态与操作（session 模式缺省）。 */
  draftWorkbenchTabs?: SessionWorkbenchTabs;
}

const SessionScopeContext = createContext<SessionScope | null>(null);

export function SessionScopeProvider({ scope, children }: { scope: SessionScope; children: ReactNode }) {
  return <SessionScopeContext.Provider value={scope}>{children}</SessionScopeContext.Provider>;
}

export function useSessionScope(): SessionScope {
  const scope = useContext(SessionScopeContext);
  if (!scope) throw new Error("Session session scope is unavailable");
  return scope;
}

export function useSessionControl() {
  const { record } = useSessionScope();
  return useExternalStoreSelector(record.stores.control, selectSnapshot);
}

export function useSessionControlSelector<T>(selector: (control: SessionControlState | null) => T): T {
  const { record } = useSessionScope();
  return useExternalStoreSelector(record.stores.control, selector);
}

export function useSessionTimeline() {
  const { record } = useSessionScope();
  return useExternalStoreSelector(record.stores.timeline, selectSnapshot);
}

export function useSessionTimelineSelector<T>(selector: (timeline: PiThreadSnapshot) => T): T {
  const { record } = useSessionScope();
  return useExternalStoreSelector(record.stores.timeline, selector);
}

export function useSessionWorkbench() {
  const { record } = useSessionScope();
  return useExternalStoreSelector(record.stores.workbench, selectSnapshot);
}

export function useSessionWorkbenchSelector<T>(selector: (workbench: WorkbenchState | null) => T): T {
  const { record } = useSessionScope();
  return useExternalStoreSelector(record.stores.workbench, selector);
}

export function useSessionConnection() {
  const { record } = useSessionScope();
  return useExternalStoreSelector(record.stores.connection, selectSnapshot);
}

export function useSessionSummary() {
  const { record } = useSessionScope();
  return useExternalStoreSelector(record.stores.summary, selectSnapshot);
}

/**
 * 绑定到当前主 session 的 workbench tab 状态与操作：
 * 每个主 session 的 tab 集合互相隔离，切换 session 不串台。
 * 新会话草稿模式（scope.isDraft）返回草稿自身的页面级 tab 状态。
 */
export function useSessionWorkbenchTabs(): SessionWorkbenchTabs {
  const { record, draftWorkbenchTabs } = useSessionScope();
  const windowTabs = useWorkbenchTabs();
  return useMemo(() => {
    if (draftWorkbenchTabs) return draftWorkbenchTabs;
    return {
      ...windowTabs.getState(record.key),
      openSessionTab: (tab: WorkbenchSessionTab) => windowTabs.openSessionTab(record.key, tab),
      openPanelTab: (panel: string) => windowTabs.openPanelTab(record.key, panel),
      activate: (key: string | null) => windowTabs.activate(record.key, key),
      closeTab: (key: string) => windowTabs.closeTab(record.key, key),
      openNewPanel: () => windowTabs.openNewPanel(record.key),
    };
  }, [draftWorkbenchTabs, windowTabs, record.key]);
}

function selectSnapshot<T>(snapshot: T): T {
  return snapshot;
}

export function useSessionIdentity() {
  const { record } = useSessionScope();
  return useMemo(() => record.identity, [record]);
}

/**
 * 在应用内 workbench 文件面板打开路径：预览打开 + 展开父目录链 + 打开侧边栏并选中资源管理 tab。
 * 返回是否已应用内打开（workbench store 未就绪时为 false）。
 */
export function useOpenWorkbenchFileInPanel(): (path: string) => boolean {
  const { record, updateWorkbench } = useSessionScope();
  const tabs = useSessionWorkbenchTabs();
  return useCallback(
    (path: string) => {
      const workbench = record.stores.workbench.getSnapshot();
      if (!workbench) return false;
      updateWorkbench({ ...openWorkbenchFilePatch(workbench, path), panelOpen: true });
      tabs.openPanelTab(FILES_PANEL_KIND);
      return true;
    },
    [record, tabs, updateWorkbench],
  );
}

/** workbench 组件（底部终端/右侧 Panel）可挂载：真实会话需 control 就绪，新会话草稿需已选项目。 */
export function useWorkbenchAccessible(): boolean {
  const { isDraft, record } = useSessionScope();
  const hasControl = useSessionControlSelector((control) => control !== null);
  if (!hasControl && !isDraft) return false;
  if (isDraft && !record.identity.projectId) return false;
  return true;
}
