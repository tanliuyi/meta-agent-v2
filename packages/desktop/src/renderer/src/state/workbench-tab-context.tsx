import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useReducer } from "react";
import { useSessionCacheRecords } from "./session-cache-context.tsx";

/** 在 workbench-panel 中注册的一个会话 tab。 */
export interface WorkbenchSessionTab {
  kind: "session";
  /** 会话定位键，等于 sessionRecordKey(projectId, threadId)。 */
  key: string;
  projectId: string;
  threadId: string;
  /** subagent 会话的 agent 身份（原始名称）；普通会话缺省。 */
  agentName?: string;
  /** Tab 展示名（subagent 为内置中文名或原始名称，普通会话为标题）。 */
  displayName: string;
}

/**
 * 在 workbench-panel 中注册的一个内置/扩展 Panel tab。
 * kind 为面板注册键（见 panel-tab-registry），展示与内容经注册表解析，不在此硬编码。
 */
export interface WorkbenchPanelTab {
  kind: "panel";
  panel: string;
}

/** workbench-panel 中注册的 tab：会话或面板（含新会话草稿），均可关闭。 */
export type WorkbenchTab = WorkbenchSessionTab | WorkbenchPanelTab;

/** tab 的定位键：会话用 session key，面板使用 workbenchPanelTabKey(kind)。 */
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
  activate(key: string | null): void;
  closeTab(key: string): void;
  openNewPanel(): void;
}

export type WorkbenchTabAction =
  | { type: "open-session-tab"; tab: WorkbenchSessionTab }
  | { type: "open-panel-tab"; panel: string }
  | { type: "activate"; key: string | null }
  | { type: "close-tab"; key: string }
  | { type: "open-new-panel" };

/** 窗口级 workbench tab 变更：作用于指定 session，或清理已 retire 的 session。 */
export type WorkbenchTabStatesAction =
  | { type: "session"; sessionKey: string; action: WorkbenchTabAction }
  | { type: "prune"; keep: ReadonlySet<string> };

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

interface WorkbenchTabContextValue {
  /** 读取指定主 session 的 tab 状态。 */
  getState(sessionKey: string): WorkbenchTabState;
  /** 在指定主 session 中注册会话 tab 并选中；重复注册只做选中。 */
  openSessionTab(sessionKey: string, tab: WorkbenchSessionTab): void;
  /** 在指定主 session 中注册面板 tab（kind 见 panel-tab-registry）并选中。 */
  openPanelTab(sessionKey: string, panel: string): void;
  /** 选中/取消选中指定主 session 的 tab；null 表示回到新建 Panel 缺省页。 */
  activate(sessionKey: string, key: string | null): void;
  closeTab(sessionKey: string, key: string): void;
  /** 打开指定主 session 的新建 Panel 缺省页（取消 tab 选中）。 */
  openNewPanel(sessionKey: string): void;
}

const WorkbenchTabContext = createContext<WorkbenchTabContextValue | null>(null);

/**
 * 窗口级 workbench tab 状态：按主 session 隔离存储，在对应 session 的 workbench-panel 中渲染。
 * 已 retire 的 session 状态随 cache 记录清理。
 */
export function WorkbenchTabProvider({ children }: { children: ReactNode }) {
  const records = useSessionCacheRecords();
  const [states, dispatch] = useReducer(reduceWorkbenchTabStates, {});
  const recordKeys = useMemo(() => new Set(records.map((record) => record.key)), [records]);
  useEffect(() => {
    dispatch({ type: "prune", keep: recordKeys });
  }, [recordKeys]);

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
    () => ({ getState, openSessionTab, openPanelTab, activate, closeTab, openNewPanel }),
    [getState, openSessionTab, openPanelTab, activate, closeTab, openNewPanel],
  );
  return <WorkbenchTabContext.Provider value={value}>{children}</WorkbenchTabContext.Provider>;
}

export function useWorkbenchTabs(): WorkbenchTabContextValue {
  const value = useContext(WorkbenchTabContext);
  if (!value) throw new Error("useWorkbenchTabs must be used inside WorkbenchTabProvider");
  return value;
}
