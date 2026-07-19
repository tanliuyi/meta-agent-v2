import { useDesktopActions, useDesktopSelector } from "../../state/desktop-context.tsx";
import {
  selectActiveCommands,
  selectActiveEditorRevision,
  selectActiveEditorText,
  selectActiveExtensionWidgets,
  selectActiveModel,
  selectActiveModels,
  selectActiveProjectId,
  selectActiveReadiness,
  selectActiveThinkingLevel,
  selectActiveThinkingLevels,
  selectActiveThreadId,
} from "../../state/desktop-selectors.ts";
import { Composer } from "./composer.tsx";

/** 只订阅 Composer 实际消费的 control 叶子字段。 */
export function SessionComposer() {
  const projectId = useDesktopSelector(selectActiveProjectId);
  const threadId = useDesktopSelector(selectActiveThreadId);
  const model = useDesktopSelector(selectActiveModel);
  const models = useDesktopSelector(selectActiveModels);
  const commands = useDesktopSelector(selectActiveCommands);
  const thinkingLevel = useDesktopSelector(selectActiveThinkingLevel);
  const thinkingLevels = useDesktopSelector(selectActiveThinkingLevels);
  const readiness = useDesktopSelector(selectActiveReadiness);
  const widgets = useDesktopSelector(selectActiveExtensionWidgets);
  const editorRevision = useDesktopSelector(selectActiveEditorRevision);
  const editorText = useDesktopSelector(selectActiveEditorText);
  const actions = useDesktopActions();
  if (!projectId || !threadId || !readiness) return null;
  return (
    <Composer
      mode="session"
      projectId={projectId}
      threadId={threadId}
      model={model}
      models={models}
      commands={commands}
      thinkingLevel={thinkingLevel}
      thinkingLevels={thinkingLevels}
      readiness={readiness}
      widgets={widgets}
      editorRevision={editorRevision}
      editorText={editorText}
      onClearQueue={actions.clearQueue}
    />
  );
}
