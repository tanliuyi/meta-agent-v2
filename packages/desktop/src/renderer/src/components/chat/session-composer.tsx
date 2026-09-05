import { useCallback, useState } from "react";
import type { SessionControlState } from "../../../../shared/contracts.ts";
import { ConfirmDialog } from "../../shared/ui/confirm-dialog.tsx";
import { useDesktopActions } from "../../state/desktop-context.tsx";
import { useSessionControlSelector, useSessionScope, useSessionTimelineSelector } from "../session-context.tsx";
import { Composer } from "./composer/composer.tsx";
import { HostRequestDialog } from "./host-request-dialog.tsx";
import { ReadOnlySessionStatus } from "./session-read-only-status.tsx";
import { useSessionPlugins } from "./use-session-plugins.ts";

/** Reads Composer control data from the owning cached session record. */
export function SessionComposer() {
  const { record, clearQueue, commandsReady, modelsRefreshing, refreshModels, setModel, setThinking } =
    useSessionScope();
  const actions = useDesktopActions();
  const [pendingStop, setPendingStop] = useState(false);
  const [stopping, setStopping] = useState(false);
  const hasControl = useSessionControlSelector((control) => control !== null);
  const interaction = useSessionControlSelector((control) => control?.interaction);
  const plugins = useSessionPlugins(record.identity.projectId, record.identity.threadId, interaction !== "read-only");
  const model = useSessionControlSelector((control) => control?.model);
  const models = useSessionControlSelector((control) => control?.models ?? EMPTY_MODELS);
  const commands = useSessionControlSelector((control) => control?.commands ?? EMPTY_COMMANDS);
  const context = useSessionControlSelector((control) => control?.context);
  const thinkingLevel = useSessionControlSelector((control) => control?.thinkingLevel ?? "off");
  const thinkingLevels = useSessionControlSelector((control) => control?.thinkingLevels ?? EMPTY_THINKING_LEVELS);
  const readiness = useSessionControlSelector((control) => control?.readiness);
  const widgets = useSessionControlSelector((control) => control?.extensionHost.widgets ?? EMPTY_WIDGETS);
  const composerCommand = useSessionControlSelector((control) => control?.extensionHost.composerCommand);
  const working = useSessionControlSelector((control) => control?.extensionHost.working);
  const hostRequest = useSessionControlSelector((control) => control?.hostRequests[0]);
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
  if (interaction === "read-only" && !hostRequest) {
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

  const composer =
    interaction === "read-only" ? null : (
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
        onClearQueue={clearQueue}
        onRefreshModels={refreshModels}
        onSetModel={setModel}
        onSetThinking={setThinking}
        plugins={plugins.plugins}
        enabledPluginIds={plugins.enabledPluginIds}
        pluginsLoading={plugins.loading}
        pluginsDisabled={plugins.applying}
        onPluginsChange={(enabledPluginIds) => {
          plugins.clearError();
          void plugins.apply(enabledPluginIds);
        }}
      />
    );

  return (
    <>
      {composer ? (
        <div
          data-composer-container
          hidden={Boolean(hostRequest)}
          inert={hostRequest ? true : undefined}
          aria-hidden={hostRequest ? true : undefined}
        >
          {composer}
        </div>
      ) : null}
      {hostRequest ? (
        <HostRequestDialog
          key={hostRequest.id}
          request={hostRequest}
          projectId={record.identity.projectId}
          threadId={record.identity.threadId}
        />
      ) : composer ? (
        <ConfirmDialog
          open={plugins.pendingAbortSelection !== null}
          title="切换会话插件"
          description="当前会话正在运行，更改插件会中止运行中的任务。已经生成的内容会保留。"
          confirmLabel="中止并切换"
          onOpenChange={(open) => {
            if (!open) plugins.clearPendingAbort();
          }}
          onConfirm={() => void plugins.applyConfirmedAbort()}
        />
      ) : null}
    </>
  );
}

const EMPTY_MODELS: SessionControlState["models"] = [];
const EMPTY_COMMANDS: SessionControlState["commands"] = [];
const EMPTY_THINKING_LEVELS: SessionControlState["thinkingLevels"] = [];
const EMPTY_WIDGETS: SessionControlState["extensionHost"]["widgets"] = [];
