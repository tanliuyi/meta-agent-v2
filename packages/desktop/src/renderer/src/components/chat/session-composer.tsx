import type { SessionControlState } from "../../../../shared/contracts.ts";
import { useSessionControlSelector, useSessionScope, useSessionTimelineSelector } from "../session-context.tsx";
import { Composer } from "./composer/composer.tsx";
import { ReadOnlySessionStatus } from "./session-read-only-status.tsx";

/** Reads Composer control data from the owning cached session record. */
export function SessionComposer() {
  const { record, clearQueue, commandsReady, modelsRefreshing, refreshModels, setModel, setThinking } =
    useSessionScope();
  const hasControl = useSessionControlSelector((control) => control !== null);
  const interaction = useSessionControlSelector((control) => control?.interaction);
  const model = useSessionControlSelector((control) => control?.model);
  const models = useSessionControlSelector((control) => control?.models ?? EMPTY_MODELS);
  const commands = useSessionControlSelector((control) => control?.commands ?? EMPTY_COMMANDS);
  const thinkingLevel = useSessionControlSelector((control) => control?.thinkingLevel ?? "off");
  const thinkingLevels = useSessionControlSelector((control) => control?.thinkingLevels ?? EMPTY_THINKING_LEVELS);
  const readiness = useSessionControlSelector((control) => control?.readiness);
  const widgets = useSessionControlSelector((control) => control?.extensionHost.widgets ?? EMPTY_WIDGETS);
  const composerCommand = useSessionControlSelector((control) => control?.extensionHost.composerCommand);
  const phase = useSessionTimelineSelector((timeline) => timeline.phase);
  const queue = useSessionTimelineSelector((timeline) => timeline.queue);
  if (!hasControl || !readiness) return null;
  if (interaction === "read-only") {
    return <ReadOnlySessionStatus phase={phase} model={model} thinkingLevel={thinkingLevel} />;
  }
  return (
    <Composer
      mode="session"
      projectId={record.identity.projectId}
      threadId={record.identity.threadId}
      model={model}
      models={models}
      commands={commands}
      thinkingLevel={thinkingLevel}
      thinkingLevels={thinkingLevels}
      readiness={readiness}
      phase={phase}
      queue={queue}
      widgets={widgets}
      composerCommand={composerCommand}
      commandsReady={commandsReady}
      modelsLoading={modelsRefreshing}
      onClearQueue={clearQueue}
      onRefreshModels={refreshModels}
      onSetModel={setModel}
      onSetThinking={setThinking}
    />
  );
}

const EMPTY_MODELS: SessionControlState["models"] = [];
const EMPTY_COMMANDS: SessionControlState["commands"] = [];
const EMPTY_THINKING_LEVELS: SessionControlState["thinkingLevels"] = [];
const EMPTY_WIDGETS: SessionControlState["extensionHost"]["widgets"] = [];
