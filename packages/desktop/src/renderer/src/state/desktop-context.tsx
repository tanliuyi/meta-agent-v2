import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { createContext, type ReactNode, useContext, useRef } from "react";
import { useStore } from "zustand";
import type { DesktopThreadActions } from "../runtime/use-pi-runtime.ts";
import { usePiRuntime } from "../runtime/use-pi-runtime.ts";
import type { DesktopActions } from "./desktop-actions.ts";
import type { DesktopState } from "./desktop-model.ts";
import { selectActiveThreadId, selectIsSendDisabled } from "./desktop-selectors.ts";
import { useDesktopStore } from "./desktop-store-context.tsx";
import { useDesktopController } from "./use-desktop-controller.ts";

export const DesktopActionsContext = createContext<DesktopActions | null>(null);

/**
 * 向聊天工作区注入 route-scoped controller 与 assistant-ui runtime。
 *
 * Context 只发布稳定的 store/commands identity；组件通过 selector 订阅实际使用的原子字段。
 */
export function DesktopProvider({ children }: { children: ReactNode }) {
  const store = useDesktopStore();
  const threadActions = useRef<DesktopThreadActions | null>(null);
  const desktopActions = useDesktopController(store, threadActions);
  const projects = useStore(store, (state) => state.projects);
  const project = useStore(store, (state) => state.project);
  const threadCatalogs = useStore(store, (state) => state.threadCatalogs);
  const threadId = useStore(store, selectActiveThreadId);
  const isSendDisabled = useStore(store, selectIsSendDisabled);
  const { runtime, actions: runtimeActions } = usePiRuntime({
    projects,
    project,
    threadCatalogs,
    threadId,
    isSendDisabled,
  });
  threadActions.current = runtimeActions;
  return (
    <DesktopActionsContext.Provider value={desktopActions}>
      <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>
    </DesktopActionsContext.Provider>
  );
}

/** 订阅 Desktop store 的单个派生值；selector 应返回 primitive 或稳定领域引用。 */
export function useDesktopSelector<T>(selector: (state: DesktopState) => T): T {
  return useStore(useDesktopStore(), selector);
}

/** 读取稳定的 Desktop 命令集合，不订阅任何状态。 */
export function useDesktopActions(): DesktopActions {
  const actions = useContext(DesktopActionsContext);
  if (!actions) throw new Error("useDesktopActions 必须在 DesktopProvider 内使用");
  return actions;
}
