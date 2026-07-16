import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { DevToolsModal } from "@assistant-ui/react-devtools";
import { createContext, type ReactNode, useContext, useMemo, useRef } from "react";
import type { DesktopThreadActions } from "../runtime/use-pi-runtime.ts";
import { usePiRuntime } from "../runtime/use-pi-runtime.ts";
import type { DesktopContextValue } from "./desktop-model.ts";
import { useDesktopController } from "./use-desktop-controller.ts";

const DesktopContext = createContext<DesktopContextValue | null>(null);
type DesktopNavigationValue = Pick<
  DesktopContextValue,
  | "projects"
  | "project"
  | "draft"
  | "threadCatalogs"
  | "threadId"
  | "chooseProject"
  | "loadProjectThreads"
  | "removeProject"
  | "beginDraft"
  | "openThread"
  | "renameThread"
  | "setThreadArchived"
  | "removeThread"
>;
const DesktopNavigationContext = createContext<DesktopNavigationValue | null>(null);

/** 向 renderer 组件树注入 Desktop controller。 */
export function DesktopProvider({ children }: { children: ReactNode }) {
  const threadActions = useRef<DesktopThreadActions | null>(null);
  const desktop = useDesktopController(threadActions);
  const { runtime, actions } = usePiRuntime({
    projects: desktop.projects,
    project: desktop.project,
    threadCatalogs: desktop.threadCatalogs,
    threadId: desktop.threadId,
    isSendDisabled: desktop.draft
      ? desktop.draft.config?.readiness.state !== "ready"
      : desktop.snapshot?.readiness.state !== "ready",
  });
  threadActions.current = actions;
  const navigation = useMemo<DesktopNavigationValue>(
    () => ({
      projects: desktop.projects,
      project: desktop.project,
      draft: desktop.draft,
      threadCatalogs: desktop.threadCatalogs,
      threadId: desktop.threadId,
      chooseProject: desktop.chooseProject,
      loadProjectThreads: desktop.loadProjectThreads,
      removeProject: desktop.removeProject,
      beginDraft: desktop.beginDraft,
      openThread: desktop.openThread,
      renameThread: desktop.renameThread,
      setThreadArchived: desktop.setThreadArchived,
      removeThread: desktop.removeThread,
    }),
    [
      desktop.projects,
      desktop.project,
      desktop.draft,
      desktop.threadCatalogs,
      desktop.threadId,
      desktop.chooseProject,
      desktop.loadProjectThreads,
      desktop.removeProject,
      desktop.beginDraft,
      desktop.openThread,
      desktop.renameThread,
      desktop.setThreadArchived,
      desktop.removeThread,
    ],
  );
  return (
    <DesktopNavigationContext.Provider value={navigation}>
      <DesktopContext.Provider value={desktop}>
        <AssistantRuntimeProvider runtime={runtime}>
          <DevToolsModal />
          {children}
        </AssistantRuntimeProvider>
      </DesktopContext.Provider>
    </DesktopNavigationContext.Provider>
  );
}

/** 读取 Desktop 工作台状态。 */
export function useDesktop(): DesktopContextValue {
  const value = useContext(DesktopContext);
  if (!value) throw new Error("useDesktop 必须在 DesktopProvider 内使用");
  return value;
}

/** 订阅 Project、session 列表与导航命令，隔离 session control 更新。 */
export function useDesktopNavigation(): DesktopNavigationValue {
  const value = useContext(DesktopNavigationContext);
  if (!value) throw new Error("useDesktopNavigation 必须在 DesktopProvider 内使用");
  return value;
}
