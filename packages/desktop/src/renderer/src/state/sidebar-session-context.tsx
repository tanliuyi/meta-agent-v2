import { createContext, type ReactNode, useCallback, useContext, useMemo, useReducer } from "react";

/** 在 workbench-panel（右侧侧边栏）中注册的一个会话 tab。 */
export interface SidebarSessionTab {
  /** 会话定位键，等于 sessionRecordKey(projectId, threadId)。 */
  readonly key: string;
  readonly projectId: string;
  readonly threadId: string;
  /** subagent 会话的 agent 身份（原始名称）；普通会话缺省。 */
  readonly agentName?: string;
  /** Tab 展示名（subagent 为内置中文名或原始名称，普通会话为标题）。 */
  readonly displayName: string;
}

export interface SidebarSessionState {
  tabs: readonly SidebarSessionTab[];
  /** 当前选中的侧边栏 tab；null 表示展示 workbench 的固定 tab。 */
  activeKey: string | null;
  /** 新建 Panel 内容模式：closed 为固定 tab/会话 tab，default 为缺省页，draft 为新会话草稿。 */
  newPanel: "closed" | "default" | "draft";
}

export type SidebarSessionAction =
  | { type: "open-in-sidebar"; tab: SidebarSessionTab }
  | { type: "activate"; key: string | null }
  | { type: "close-tab"; key: string }
  | { type: "open-new-panel" }
  | { type: "start-new-draft" };

export const SIDEBAR_SESSION_INITIAL_STATE: SidebarSessionState = {
  tabs: [],
  activeKey: null,
  newPanel: "closed",
};

/** 侧边栏 tab 状态转换；纯函数便于单测。 */
export function reduceSidebarSessionState(
  state: SidebarSessionState,
  action: SidebarSessionAction,
): SidebarSessionState {
  switch (action.type) {
    case "open-in-sidebar": {
      const tabs = state.tabs.some((tab) => tab.key === action.tab.key) ? state.tabs : [...state.tabs, action.tab];
      return { tabs, activeKey: action.tab.key, newPanel: "closed" };
    }
    case "activate":
      return state.activeKey === action.key && state.newPanel === "closed"
        ? state
        : { ...state, activeKey: action.key, newPanel: "closed" };
    case "close-tab": {
      const closedIndex = state.tabs.findIndex((tab) => tab.key === action.key);
      if (closedIndex === -1) return state;
      const tabs = state.tabs.filter((tab) => tab.key !== action.key);
      if (tabs.length === 0) return { tabs, activeKey: null, newPanel: state.newPanel };
      const activeKey =
        state.activeKey === action.key ? tabs[Math.min(closedIndex, tabs.length - 1)]!.key : state.activeKey;
      return { tabs, activeKey, newPanel: state.newPanel };
    }
    case "open-new-panel":
      return state.newPanel === "default" && state.activeKey === null
        ? state
        : { ...state, activeKey: null, newPanel: "default" };
    case "start-new-draft":
      return state.newPanel === "draft" ? state : { ...state, newPanel: "draft" };
  }
}

interface SidebarSessionContextValue extends SidebarSessionState {
  /** 注册 tab 并选中该 tab；重复注册只做选中。panel 打开由所在 session 的 workbench 状态控制。 */
  openInSidebar(tab: SidebarSessionTab): void;
  /** 选中/取消选中侧边栏 tab；null 表示回到 workbench 固定 tab。 */
  activate(key: string | null): void;
  closeTab(key: string): void;
  /** 打开新建 Panel 缺省页。 */
  openNewPanel(): void;
  /** 从缺省页进入新会话草稿。 */
  startNewDraft(): void;
}

const SidebarSessionContext = createContext<SidebarSessionContextValue | null>(null);

/** 窗口级侧边栏会话 tab 状态：在任意 session 的 workbench-panel 中渲染。 */
export function SidebarSessionProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reduceSidebarSessionState, SIDEBAR_SESSION_INITIAL_STATE);

  const openInSidebar = useCallback((tab: SidebarSessionTab) => dispatch({ type: "open-in-sidebar", tab }), []);
  const activate = useCallback((key: string | null) => dispatch({ type: "activate", key }), []);
  const closeTab = useCallback((key: string) => dispatch({ type: "close-tab", key }), []);
  const openNewPanel = useCallback(() => dispatch({ type: "open-new-panel" }), []);
  const startNewDraft = useCallback(() => dispatch({ type: "start-new-draft" }), []);

  const value = useMemo(
    () => ({ ...state, openInSidebar, activate, closeTab, openNewPanel, startNewDraft }),
    [state, openInSidebar, activate, closeTab, openNewPanel, startNewDraft],
  );
  return <SidebarSessionContext.Provider value={value}>{children}</SidebarSessionContext.Provider>;
}

export function useSidebarSessions(): SidebarSessionContextValue {
  const value = useContext(SidebarSessionContext);
  if (!value) throw new Error("useSidebarSessions must be used inside SidebarSessionProvider");
  return value;
}
