import { useCallback, useMemo, useState } from "react";
import type { SessionControlState } from "../../../../shared/contracts.ts";
import { ConfirmDialog } from "../../shared/ui/confirm-dialog.tsx";
import { useDesktopActions } from "../../state/desktop-context.tsx";
import { useSessionControlSelector, useSessionScope, useSessionTimelineSelector } from "../session-context.tsx";
import { Composer } from "./composer/composer.tsx";
import { ReadOnlySessionStatus } from "./session-read-only-status.tsx";

/** Reads Composer control data from the owning cached session record. */
export function SessionComposer() {
  const { record, commandsReady, modelsRefreshing, setModel, setThinking } = useSessionScope();
  const actions = useDesktopActions();
  const [pendingStop, setPendingStop] = useState(false);
  const [stopping, setStopping] = useState(false);
  const hasControl = useSessionControlSelector((control) => control !== null);
  const interaction = useSessionControlSelector((control) => control?.interaction);
  const model = useSessionControlSelector((control) => control?.model);
  const models = useSessionControlSelector((control) => control?.models ?? EMPTY_MODELS);
  const commands = useSessionControlSelector((control) => control?.commands ?? EMPTY_COMMANDS);
  const context = useSessionControlSelector((control) => control?.context);
  const thinkingLevel = useSessionControlSelector((control) => control?.thinkingLevel ?? "off");
  const thinkingLevels = useSessionControlSelector((control) => control?.thinkingLevels ?? EMPTY_THINKING_LEVELS);
  const readiness = useSessionControlSelector((control) => control?.readiness);
  const extensionWidgets = useSessionControlSelector((control) => control?.extensionHost.widgets ?? EMPTY_WIDGETS);
  const extensionStatuses = useSessionControlSelector((control) => control?.extensionHost.statuses ?? EMPTY_STATUSES);
  const widgets = useMemo(() => {
    const statusLines = Object.values(extensionStatuses);
    return statusLines.length > 0
      ? [{ key: "system-pi-status", lines: statusLines, placement: "aboveEditor" as const }, ...extensionWidgets]
      : extensionWidgets;
  }, [extensionStatuses, extensionWidgets]);
  const composerCommand = useSessionControlSelector((control) => control?.extensionHost.composerCommand);
  const working = useSessionControlSelector((control) => control?.extensionHost.working);
  const phase = useSessionTimelineSelector((timeline) => timeline.phase);
  const queue = useSessionTimelineSelector((timeline) => timeline.queue);
  const confirmStop = useCallback(() => {
    setPendingStop(false);
    setStopping(true);
    void actions
      .stopThread(record.identity.projectId, record.identity.threadId)
      .catch(() => undefined)
      .finally(() => setStopping(false));
  }, [actions, record.identity.projectId, record.identity.threadId]);
  if (!hasControl || !readiness) return null;
  if (interaction === "read-only") {
    return (
      <>
        <ReadOnlySessionStatus
          phase={phase}
          model={model}
          thinkingLevel={thinkingLevel}
          onStop={() => setPendingStop(true)}
          stopPending={stopping}
        />
        <ConfirmDialog
          open={pendingStop}
          title="停止子智能体"
          description="停止运行中的子智能体。已经生成的会话内容会保留。"
          confirmLabel="停止"
          onOpenChange={setPendingStop}
          onConfirm={confirmStop}
        />
      </>
    );
  }
  return (
    <>
      <Composer
        mode="session"
        projectId={record.identity.projectId}
        threadId={record.identity.threadId}
        model={model}
        models={models}
        commands={commands}
        context={context}
        thinkingLevel={thinkingLevel}
        thinkingLevels={thinkingLevels}
        readiness={readiness}
        phase={phase}
        queue={queue}
        widgets={widgets}
        composerCommand={composerCommand}
        working={working}
        commandsReady={commandsReady}
        modelsLoading={modelsRefreshing}
        onSetModel={setModel}
        onSetThinking={setThinking}
      />
    </>
  );
}

const EMPTY_MODELS: SessionControlState["models"] = [];
const EMPTY_COMMANDS: SessionControlState["commands"] = [];
const EMPTY_THINKING_LEVELS: SessionControlState["thinkingLevels"] = [];
const EMPTY_WIDGETS: SessionControlState["extensionHost"]["widgets"] = [];
const EMPTY_STATUSES: SessionControlState["extensionHost"]["statuses"] = {};
