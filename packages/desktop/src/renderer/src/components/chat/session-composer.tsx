import { useSessionControl, useSessionScope, useSessionTimeline } from "../session-context.tsx";
import { Composer } from "./composer/composer.tsx";
import { ReadOnlySessionStatus } from "./session-read-only-status.tsx";

/** Reads Composer control data from the owning cached session record. */
export function SessionComposer() {
  const { record, clearQueue, commandsReady, modelsRefreshing, refreshModels, setModel, setThinking } =
    useSessionScope();
  const control = useSessionControl();
  const timeline = useSessionTimeline();
  if (!control) return null;
  if (control.interaction === "read-only") {
    return <ReadOnlySessionStatus phase={timeline.phase} model={control.model} thinkingLevel={control.thinkingLevel} />;
  }
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
      widgets={control.extensionHost.widgets}
      composerCommand={control.extensionHost.composerCommand}
      commandsReady={commandsReady}
      modelsLoading={modelsRefreshing}
      onClearQueue={clearQueue}
      onRefreshModels={refreshModels}
      onSetModel={setModel}
      onSetThinking={setThinking}
    />
  );
}
