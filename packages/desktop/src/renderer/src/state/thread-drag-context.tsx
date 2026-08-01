import { createContext, type ReactNode, useContext, useMemo, useState } from "react";

/** 侧边栏会话拖拽的自定义 MIME；仅当前窗口内拖拽使用。 */
export const THREAD_DRAG_MIME = "application/x-meta-agent-thread";

/** 正在拖拽的会话摘要（拖拽源写入，drop zone 读取）。 */
export interface DraggedThread {
  projectId: string;
  threadId: string;
  title: string;
  agentName?: string;
}

interface ThreadDragContextValue {
  dragged: DraggedThread | null;
  setDragged(dragged: DraggedThread | null): void;
}

const ThreadDragContext = createContext<ThreadDragContextValue | null>(null);

/** 窗口级会话拖拽状态：dragstart 写入、dragend/drop 清除，驱动 drop zone 占位。 */
export function ThreadDragProvider({ children }: { children: ReactNode }) {
  const [dragged, setDragged] = useState<DraggedThread | null>(null);
  const value = useMemo(() => ({ dragged, setDragged }), [dragged]);
  return <ThreadDragContext.Provider value={value}>{children}</ThreadDragContext.Provider>;
}

/** 读取当前拖拽的会话；provider 缺失（如 SSR 渲染测试）时返回 no-op。 */
export function useThreadDrag(): ThreadDragContextValue {
  return useContext(ThreadDragContext) ?? { dragged: null, setDragged: () => undefined };
}
