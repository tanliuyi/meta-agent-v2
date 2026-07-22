import { useDesktopActions, useDesktopSelector } from "../../state/desktop-context.tsx";
import { DraftComposerThread } from "./draft-composer-thread.tsx";

/** 隔离新会话草稿状态，避免 session message surface 订阅 draft 配置。 */
export function DraftChatThread() {
  const projects = useDesktopSelector((state) => state.projects);
  const draft = useDesktopSelector((state) => state.draft);
  const actions = useDesktopActions();
  if (!draft) return null;
  const project = projects.find(({ id }) => id === draft.projectId) ?? null;

  return (
    <DraftComposerThread
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
  );
}
