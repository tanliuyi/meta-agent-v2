import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import type { WorkbenchState } from "../../../shared/contracts.ts";
import type { WorkbenchStore } from "../runtime/pi-session-store.ts";
import { useDraftSession } from "./draft-session-context.tsx";
import {
  reduceWorkbenchTabState,
  type SessionWorkbenchTabs,
  WORKBENCH_TAB_INITIAL_STATE,
} from "./workbench-tab-context.tsx";

/**
 * 新会话草稿的虚拟 session threadId：草稿尚未 materialize 成真实会话，
 * 终端/资源管理等项目级能力借用该占位 threadId 隔离 PTY 键（不会与真实会话冲突）。
 */
export const DRAFT_THREAD_ID = "draft";

/** 草稿 workbench 布局字段（不含 projectId/threadId 与 tab 状态）。 */
interface DraftWorkbenchLayout {
  panelOpen: boolean;
  panelWidth: number;
  fileTreeWidth?: number;
  fileWrapMode?: boolean;
  fileMarkdownPreview?: boolean;
  terminalOpen: boolean;
  terminalHeight: number;
  openFiles: string[];
  activeFile?: string;
  previewFile?: string;
  expandedPaths: string[];
}

const INITIAL_LAYOUT: DraftWorkbenchLayout = {
  panelOpen: false,
  panelWidth: 0,
  terminalOpen: false,
  terminalHeight: 0,
  openFiles: [],
  expandedPaths: [],
};

interface DraftWorkbenchContextValue {
  /** 当前 workbench 快照（引用随状态变化，供 store 的 getSnapshot 复用）。 */
  workbench: WorkbenchState;
  /** 桥接 store：让 session-scoped 组件（BottomTerminal/WorkbenchPanel 等）订阅草稿状态。 */
  workbenchStore: WorkbenchStore;
  /** 更新草稿 workbench 布局/tab 状态（不持久化；新会话页面级状态）。 */
  updateWorkbench(value: Partial<WorkbenchState>): void;
  /** 草稿自身的 workbench tab 状态与操作（与 session tab 表隔离）。 */
  tabs: SessionWorkbenchTabs;
}

const DraftWorkbenchContext = createContext<DraftWorkbenchContextValue | null>(null);

/**
 * 新会话（/new 路由）页面级 workbench 状态：底部终端、右侧 Panel 及其 tab 集合。
 * 草稿尚未固定到项目 session，因此状态只存在于页面内存，不写主进程持久层；
 * projectId 取自窗口级草稿上下文（useDraftSession），切换项目时随快照更新。
 */
export function DraftWorkbenchProvider({ children }: { children: ReactNode }) {
  const { projectId } = useDraftSession();
  const [layout, setLayout] = useState<DraftWorkbenchLayout>(INITIAL_LAYOUT);
  const [tabState, dispatchTab] = useReducer(reduceWorkbenchTabState, WORKBENCH_TAB_INITIAL_STATE);
  const workbenchRef = useRef<WorkbenchState | null>(null);
  const listenersRef = useRef(new Set<() => void>());

  // 快照引用稳定：仅依赖变化时重建，供 useSyncExternalStore 对比。
  const workbench = useMemo<WorkbenchState>(() => {
    const next: WorkbenchState = {
      projectId: projectId ?? "",
      threadId: DRAFT_THREAD_ID,
      ...layout,
      tabs: [...tabState.tabs],
      activeTabKey: tabState.activeKey,
    };
    return next;
  }, [layout, projectId, tabState]);

  // 渲染产物同步到 ref（不在 render 阶段写 ref）：
  // replaceWorkbench 已同步更新 ref，这里覆盖内部状态（layout/tab）驱动的重建。
  useLayoutEffect(() => {
    workbenchRef.current = workbench;
  }, [workbench]);

  const replaceWorkbench = useCallback((next: WorkbenchState) => {
    const { tabs, activeTabKey, projectId: _projectId, threadId: _threadId, ...rest } = next;
    // 同步更新 ref，保证订阅通知后 useSyncExternalStore 立即读到新引用。
    workbenchRef.current = next;
    setLayout((current) => ({ ...current, ...rest }));
    dispatchTab({ type: "restore", tabs: tabs ?? [], activeKey: activeTabKey ?? null });
    for (const listener of listenersRef.current) listener();
  }, []);

  const workbenchStore = useMemo<WorkbenchStore>(
    () => ({
      getSnapshot: () => workbenchRef.current,
      replace: replaceWorkbench,
      subscribe(listener: () => void) {
        listenersRef.current.add(listener);
        return () => listenersRef.current.delete(listener);
      },
    }),
    [replaceWorkbench],
  );

  const updateWorkbench = useCallback(
    (value: Partial<WorkbenchState>) => {
      const current = workbenchRef.current;
      if (!current) return;
      replaceWorkbench({ ...current, ...value });
    },
    [replaceWorkbench],
  );

  const tabs = useMemo<SessionWorkbenchTabs>(
    () => ({
      ...tabState,
      openSessionTab: (tab) => dispatchTab({ type: "open-session-tab", tab }),
      openPanelTab: (panel) => dispatchTab({ type: "open-panel-tab", panel }),
      activate: (key) => dispatchTab({ type: "activate", key }),
      closeTab: (key) => dispatchTab({ type: "close-tab", key }),
      openNewPanel: () => dispatchTab({ type: "open-new-panel" }),
    }),
    [tabState],
  );

  const value = useMemo<DraftWorkbenchContextValue>(
    () => ({ workbench, workbenchStore, updateWorkbench, tabs }),
    [tabs, updateWorkbench, workbench, workbenchStore],
  );
  return <DraftWorkbenchContext.Provider value={value}>{children}</DraftWorkbenchContext.Provider>;
}

/** 读取草稿 workbench 状态与操作；仅可在 DraftWorkbenchProvider 内使用。 */
export function useDraftWorkbench(): DraftWorkbenchContextValue {
  const value = useContext(DraftWorkbenchContext);
  if (!value) throw new Error("useDraftWorkbench must be used inside DraftWorkbenchProvider");
  return value;
}
