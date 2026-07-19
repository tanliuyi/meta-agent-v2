import { ThreadPrimitive } from "@assistant-ui/react";
import { useDesktopActions, useDesktopSelector } from "../../state/desktop-context.tsx";
import { Composer } from "./composer.tsx";

/** 隔离新会话草稿状态，避免 session message surface 订阅 draft 配置。 */
export function DraftChatThread() {
  const projects = useDesktopSelector((state) => state.projects);
  const draft = useDesktopSelector((state) => state.draft);
  const actions = useDesktopActions();
  if (!draft) return null;
  const project = projects.find(({ id }) => id === draft.projectId) ?? null;

  return (
    <ThreadPrimitive.Root className="thread-root aui-root aui-thread-root @container flex h-full flex-col justify-center bg-background">
      <div className="thread-footer relative shrink-0 bg-background">
        <div className="relative mx-auto flex w-full max-w-(--layout-thread-max-width) flex-col gap-2 px-4 pb-4">
          <Composer
            mode="draft"
            projects={projects}
            project={project}
            config={draft.config}
            configLoading={draft.configLoading}
            phase={draft.phase}
            onProjectChange={actions.selectDraftProject}
            onModelChange={actions.selectDraftModel}
            onThinkingChange={actions.selectDraftThinking}
            onSubmit={actions.submitDraft}
          />
        </div>
      </div>
    </ThreadPrimitive.Root>
  );
}
