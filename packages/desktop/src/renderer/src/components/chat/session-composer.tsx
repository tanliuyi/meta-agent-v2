import { useSessionControl, useSessionScope, useSessionTimeline } from "../session-context.tsx";
import { Composer } from "./composer.tsx";

/** Reads Composer control data from the owning cached session record. */
export function SessionComposer() {
  const { record, clearQueue, commandsReady, setModel, setThinking, syncEditorText } = useSessionScope();
  const control = useSessionControl();
  const timeline = useSessionTimeline();
  if (!control) return null;
  return (
    <Composer
      mode="session"
      projectId={record.identity.projectId}
      threadId={record.identity.threadId}
      model={control.model}
      models={control.models}
      commands={control.commands}
      thinkingLevel={control.thinkingLevel}
      thinkingLevels={control.thinkingLevels}
      readiness={control.readiness}
      phase={timeline.phase}
      queue={timeline.queue}
      widgets={control.extensionUi.widgets}
      editorRevision={control.extensionUi.editorRevision}
      editorText={control.extensionUi.editorText}
      commandsReady={commandsReady}
      onClearQueue={clearQueue}
      onSetModel={setModel}
      onSetThinking={setThinking}
      onSyncEditorText={syncEditorText}
    />
  );
}
