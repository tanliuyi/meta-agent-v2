import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useDraftSession } from "../state/draft-session-context.tsx";
import { DraftWorkbenchProvider } from "../state/draft-workbench-context.tsx";
import { DraftSessionScopeProvider } from "./draft-session-scope.tsx";
import { NewSessionSurface } from "./new-session-surface.tsx";

/**
 * Mounts the route UI over the window-scoped draft runtime.
 * 草稿页面同样提供 workbench（终端/右侧 Panel）能力：DraftWorkbenchProvider 持有
 * 页面级布局与 tab 状态，DraftSessionScopeProvider 以伪 session scope 复用
 * BottomTerminal / WorkbenchPanel 等 session-scoped 组件。
 */
export function NewSessionRoute() {
  const { runtime } = useDraftSession();
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <DraftWorkbenchProvider>
        <DraftSessionScopeProvider>
          <NewSessionSurface />
        </DraftSessionScopeProvider>
      </DraftWorkbenchProvider>
    </AssistantRuntimeProvider>
  );
}
