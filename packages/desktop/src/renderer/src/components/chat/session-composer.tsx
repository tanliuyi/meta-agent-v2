import LoaderCircle from "lucide-react/dist/esm/icons/loader-circle.mjs";
import { useSessionControl, useSessionScope, useSessionTimeline } from "../session-context.tsx";
import { Composer } from "./composer/composer.tsx";

/** Reads Composer control data from the owning cached session record. */
export function SessionComposer() {
  const { record, clearQueue, commandsReady, modelsRefreshing, refreshModels, setModel, setThinking } =
    useSessionScope();
  const control = useSessionControl();
  const timeline = useSessionTimeline();
  if (!control) return null;
  if (control.interaction === "read-only") {
    return (
      <div
        className="border-border/60 flex h-10 items-center justify-center gap-2 rounded-md border bg-background/95 text-xs text-muted-foreground shadow-sm"
        role="status"
        aria-live="polite"
      >
        <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
        <span>{timeline.phase === "idle" ? "正在同步子智能体会话" : "子智能体运行中，此会话暂时只读"}</span>
      </div>
    );
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
