import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useReducer, useRef } from "react";
import type {
  WorkbenchPanelTab,
  WorkbenchSessionTab,
  WorkbenchState,
  WorkbenchTab,
  WorkbenchTerminalTab,
} from "../../../shared/contracts.ts";
import { FILES_PANEL_KIND, PROJECT_PANEL_KIND, SCM_PANEL_KIND } from "../components/panel/builtin-panel-kinds.ts";
import type { CachedSessionRecord } from "../runtime/pi-session-store.ts";
import { useSessionCacheRecords } from "./session-cache-context.tsx";

/** tab 的定位键：会话与终端用各自的 key，面板使用 workbenchPanelTabKey(kind)。 */
export function workbenchTabKey(tab: WorkbenchTab): string {
  return tab.kind === "panel" ? workbenchPanelTabKey(tab.panel) : tab.key;
}

/** 面板 kind 对应的 tab 定位键。 */
export function workbenchPanelTabKey(panel: string): string {
  return `panel:${panel}`;
}

/** 单个主 session 持有的 workbench tab 状态。 */
export interface WorkbenchTabState {
  tabs: readonly WorkbenchTab[];
  /** 当前选中的 tab 键；null 表示展示新建 Panel 缺省页。 */
  activeKey: string | null;
}

/** 按主 session 隔离的 tab 状态表：每个主 session 持有自己的 tab 集合。 */
export interface WorkbenchTabStates {
  [sessionKey: string]: WorkbenchTabState;
}

/** 绑定到单个主 session 的 workbench tab 状态与操作（供 components 层 hook 使用）。 */
export interface SessionWorkbenchTabs extends WorkbenchTabState {
  openSessionTab(tab: WorkbenchSessionTab): void;
  openPanelTab(panel: string): void;
  openTerminalTab(tab: WorkbenchTerminalTab): void;
  activate(key: string | null): void;
  closeTab(key: string): void;
  openNewPanel(): void;
}

export type WorkbenchTabAction =
  | { type: "open-session-tab"; tab: WorkbenchSessionTab }
  | { type: "open-panel-tab"; panel: string }
  | { type: "open-terminal-tab"; tab: WorkbenchTerminalTab }
  | { type: "activate"; key: string | null }
  | { type: "close-tab"; key: string }
  | { type: "open-new-panel" }
  | { type: "restore"; tabs: readonly WorkbenchTab[]; activeKey: string | null };

/** 窗口级 workbench tab 变更：作用于指定 session，或清理已 retire 的 session。 */
export type WorkbenchTabStatesAction =
  | { type: "session"; sessionKey: string; action: WorkbenchTabAction }
  | { type: "prune"; keep: ReadonlySet<string> };

function normalizePanelKind(panel: string): string {
  return panel === FILES_PANEL_KIND || panel === SCM_PANEL_KIND ? PROJECT_PANEL_KIND : panel;
}

function normalizeRestoredTabs(tabs: readonly WorkbenchTab[], activeKey: string | null): WorkbenchTabState {
  const normalized: WorkbenchTab[] = [];
  const seen = new Set<string>();
  for (const tab of tabs) {
    const next =
      tab.kind === "panel" && normalizePanelKind(tab.panel) !== tab.panel ? { ...tab, panel: PROJECT_PANEL_KIND } : tab;
    const key = workbenchTabKey(next);
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(next);
  }
  const normalizedActiveKey = activeKey?.startsWith("panel:")
    ? workbenchPanelTabKey(normalizePanelKind(activeKey.slice("panel:".length)))
    : activeKey;
  return { tabs: normalized, activeKey: normalizedActiveKey };
}

export const WORKBENCH_TAB_INITIAL_STATE: WorkbenchTabState = {
  tabs: [],
  activeKey: null,
};

/** 单个 session 的 tab 状态转换；纯函数便于单测。 */
export function reduceWorkbenchTabState(state: WorkbenchTabState, action: WorkbenchTabAction): WorkbenchTabState {
  switch (action.type) {
    case "open-session-tab": {
      // 已选中该 tab 时保持原状态引用，避免无变化时通知下游重渲染。
      if (state.activeKey === action.tab.key) return state;
      const tabs = state.tabs.some((tab) => tab.kind === "session" && tab.key === action.tab.key)
        ? state.tabs
        : [...state.tabs, action.tab];
      return { tabs, activeKey: action.tab.key };
    }
    case "open-panel-tab": {
      const key = workbenchPanelTabKey(action.panel);
      // 已选中该 tab 时保持原状态引用，避免无变化时通知下游重渲染。
      if (state.activeKey === key) return state;
      const tab: WorkbenchPanelTab = { kind: "panel", panel: action.panel };
      const tabs = state.tabs.some((candidate) => candidate.kind === "panel" && candidate.panel === action.panel)
        ? state.tabs
        : [...state.tabs, tab];
      return { tabs, activeKey: key };
    }
    case "open-terminal-tab": {
      // 已选中该 tab 时保持原状态引用；每个终端 tab 独立（允许同 displayName 多开）。
      if (state.activeKey === action.tab.key) return state;
      const tabs = state.tabs.some((tab) => workbenchTabKey(tab) === action.tab.key)
        ? state.tabs
        : [...state.tabs, action.tab];
      return { tabs, activeKey: action.tab.key };
    }
    case "activate":
      return state.activeKey === action.key ? state : { ...state, activeKey: action.key };
    case "close-tab": {
      const closedIndex = state.tabs.findIndex((tab) => workbenchTabKey(tab) === action.key);
      if (closedIndex === -1) return state;
      const tabs = state.tabs.filter((tab) => workbenchTabKey(tab) !== action.key);
      if (tabs.length === 0) return { tabs, activeKey: null };
      const activeKey =
        state.activeKey === action.key
          ? workbenchTabKey(tabs[Math.min(closedIndex, tabs.length - 1)]!)
          : state.activeKey;
      return { tabs, activeKey };
    }
    case "open-new-panel":
      return state.activeKey === null ? state : { ...state, activeKey: null };
    case "restore": {
      // 与当前状态一致时保持原引用，避免无变化时通知下游重渲染。
      const same =
        state.activeKey === action.activeKey &&
        state.tabs.length === action.tabs.length &&
        state.tabs.every((tab, index) => workbenchTabKey(tab) === workbenchTabKey(action.tabs[index]!));
      if (same) return state;
      return normalizeRestoredTabs(action.tabs, action.activeKey);
    }
  }
}

/** 按主 session 隔离的 tab 状态转换；纯函数便于单测。 */
export function reduceWorkbenchTabStates(
  states: WorkbenchTabStates,
  change: WorkbenchTabStatesAction,
): WorkbenchTabStates {
  if (change.type === "prune") {
    const removed = Object.keys(states).filter((key) => !change.keep.has(key));
    if (removed.length === 0) return states;
    const next = { ...states };
    for (const key of removed) delete next[key];
    return next;
  }
  const state = states[change.sessionKey] ?? WORKBENCH_TAB_INITIAL_STATE;
  const next = reduceWorkbenchTabState(state, change.action);
  if (next === state) return states;
  return { ...states, [change.sessionKey]: next };
}

export interface WorkbenchTabContextValue {
  /** 读取指定主 session 的 tab 状态。 */
  getState(sessionKey: string): WorkbenchTabState;
  /** 在指定主 session 中注册会话 tab 并选中；重复注册只做选中。 */
  openSessionTab(sessionKey: string, tab: WorkbenchSessionTab): void;
  /** 在指定主 session 中注册面板 tab（kind 见 panel-tab-registry）并选中。 */
  openPanelTab(sessionKey: string, panel: string): void;
  /** 在指定主 session 中注册终端 tab 并选中；重复注册只做选中。 */
  openTerminalTab(sessionKey: string, tab: WorkbenchTerminalTab): void;
  /** 选中/取消选中指定主 session 的 tab；null 表示回到新建 Panel 缺省页。 */
  activate(sessionKey: string, key: string | null): void;
  closeTab(sessionKey: string, key: string): void;
  /** 打开指定主 session 的新建 Panel 缺省页（取消 tab 选中）。 */
  openNewPanel(sessionKey: string): void;
}

const WorkbenchTabContext = createContext<WorkbenchTabContextValue | null>(null);

/** 将本地 tab 状态写回 workbench store 与主进程持久层；store 未就绪（attach 前）时跳过。 */
function persistWorkbenchTabs(record: CachedSessionRecord, state: WorkbenchTabState): void {
  const workbench = record.stores.workbench.getSnapshot();
  if (!workbench || workbenchTabsMatch(workbench, state)) return;
  const next = { ...workbench, tabs: [...state.tabs], activeTabKey: state.activeKey };
  record.stores.workbench.replace(next);
  void window.desktop.workbench.update(next).catch((error: unknown) => {
    console.error("Workbench tabs persist failed", error);
  });
}

export function workbenchTabsMatch(workbench: WorkbenchState, state: WorkbenchTabState): boolean {
  return (
    (workbench.activeTabKey ?? null) === state.activeKey &&
    (workbench.tabs?.length ?? 0) === state.tabs.length &&
    (workbench.tabs ?? []).every((tab, index) => JSON.stringify(tab) === JSON.stringify(state.tabs[index]))
  );
}

/**
 * 窗口级 workbench tab 状态：按主 session 隔离存储，在对应 session 的 workbench-panel 中渲染。
 * 已 retire 的 session 状态随 cache 记录清理。
 *
 * 持久化：本地状态变化时经 workbench store 写回主进程（随 WorkbenchState 存盘）；
 * 会话 attach 完成（如渲染进程 Ctrl+R 刷新后重新挂载）时从持久化状态恢复 tab。
 */
export function WorkbenchTabProvider({ children }: { children: ReactNode }) {
  const records = useSessionCacheRecords();
  const [states, dispatch] = useReducer(reduceWorkbenchTabStates, {});
  const statesRef = useRef(states);
  const recordKeys = useMemo(() => new Set(records.map((record) => record.key)), [records]);
  useEffect(() => {
    dispatch({ type: "prune", keep: recordKeys });
  }, [recordKeys]);

  // 本地状态是窗口内事实来源：变化时写回 workbench store 与主进程，跨刷新/重启持久化。
  // 顺带同步 statesRef，供 attach 恢复回调读取最新本地状态。
  useEffect(() => {
    statesRef.current = states;
    for (const record of records) {
      const local = states[record.key];
      if (!local) continue;
      persistWorkbenchTabs(record, local);
    }
  }, [states, records]);

  // 会话 attach 完成后从持久化状态恢复 tab（渲染进程刷新后 workbench store 由主进程重灌）。
  // 本窗口已产生过本地状态的会话以本地状态为准并回写，避免覆盖用户最新操作。
  useEffect(() => {
    const unsubscribers: Array<() => void> = [];
    for (const record of records) {
      const tryHydrate = () => {
        const workbench = record.stores.workbench.getSnapshot();
        if (!workbench) return;
        const activePanel = workbench.activeTabKey?.startsWith("panel:")
          ? workbench.activeTabKey.slice("panel:".length)
          : null;
        if (!workbench.projectPanelView && activePanel === SCM_PANEL_KIND) {
          const next = { ...workbench, projectPanelView: "scm" as const };
          record.stores.workbench.replace(next);
          void window.desktop.workbench.update(next).catch((error: unknown) => {
            console.error("Workbench project panel migration failed", error);
          });
        }
        const local = statesRef.current[record.key];
        if (local) {
          // store 已被其他写入方（如 attach 重灌）改回旧值且与本地不一致时回写；
          // 一致时不动，避免 replace 触发订阅回调形成循环。
          if (!workbenchTabsMatch(workbench, local)) persistWorkbenchTabs(record, local);
          return;
        }
        const tabs = workbench.tabs ?? [];
        const activeKey = workbench.activeTabKey ?? null;
        if (tabs.length === 0 && activeKey === null) return;
        dispatch({ type: "session", sessionKey: record.key, action: { type: "restore", tabs, activeKey } });
      };
      tryHydrate();
      unsubscribers.push(record.stores.workbench.subscribe(tryHydrate));
    }
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }, [records]);

  const openSessionTab = useCallback(
    (sessionKey: string, tab: WorkbenchSessionTab) =>
      dispatch({ type: "session", sessionKey, action: { type: "open-session-tab", tab } }),
    [],
  );
  const openPanelTab = useCallback(
    (sessionKey: string, panel: string) =>
      dispatch({ type: "session", sessionKey, action: { type: "open-panel-tab", panel } }),
    [],
  );
  const openTerminalTab = useCallback(
    (sessionKey: string, tab: WorkbenchTerminalTab) =>
      dispatch({ type: "session", sessionKey, action: { type: "open-terminal-tab", tab } }),
    [],
  );
  const activate = useCallback(
    (sessionKey: string, key: string | null) =>
      dispatch({ type: "session", sessionKey, action: { type: "activate", key } }),
    [],
  );
  const closeTab = useCallback(
    (sessionKey: string, key: string) => dispatch({ type: "session", sessionKey, action: { type: "close-tab", key } }),
    [],
  );
  const openNewPanel = useCallback(
    (sessionKey: string) => dispatch({ type: "session", sessionKey, action: { type: "open-new-panel" } }),
    [],
  );
  const getState = useCallback((sessionKey: string) => states[sessionKey] ?? WORKBENCH_TAB_INITIAL_STATE, [states]);

  const value = useMemo(
    () => ({ getState, openSessionTab, openPanelTab, openTerminalTab, activate, closeTab, openNewPanel }),
    [getState, openSessionTab, openPanelTab, openTerminalTab, activate, closeTab, openNewPanel],
  );
  return <WorkbenchTabContext.Provider value={value}>{children}</WorkbenchTabContext.Provider>;
}

export function useWorkbenchTabs(): WorkbenchTabContextValue {
  const value = useContext(WorkbenchTabContext);
  if (!value) throw new Error("useWorkbenchTabs must be used inside WorkbenchTabProvider");
  return value;
}
