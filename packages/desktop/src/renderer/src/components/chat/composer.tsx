import { ComposerPrimitive, useAui, useAuiEvent, useAuiState } from "@assistant-ui/react";
import { ArrowUp, RotateCcw, Square } from "lucide-react";
import { type FormEvent, type KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import type { DraftSessionConfig, Project, SessionControlState } from "../../../../shared/contracts.ts";
import { usePiThreadPhase } from "../../runtime/use-pi-thread-snapshot.ts";
import type { DraftSessionState } from "../../state/desktop-model.ts";
import { ComposerAddAttachment, ComposerAttachments } from "../assistant-ui/attachment.tsx";
import { TooltipIconButton } from "../assistant-ui/tooltip-icon-button.tsx";
import { TextButton } from "../ui/text-button.tsx";
import { ModelSelect, ProjectSelect, ThinkingSelect } from "./composer-controls.tsx";
import { ComposerSuggestions, type ComposerSuggestionsHandle } from "./composer-suggestions.tsx";

const ESCAPE_CANCEL_WINDOW_MS = 1_000;

type ComposerProps =
  | {
      mode: "draft";
      projects: readonly Project[];
      project: Project | null;
      config: DraftSessionConfig | null;
      configLoading: boolean;
      phase: DraftSessionState["phase"];
      onProjectChange(projectId: string): Promise<void>;
      onModelChange(provider: string, modelId: string): void;
      onThinkingChange(level: SessionControlState["thinkingLevel"]): void;
      onSubmit(): Promise<void>;
    }
  | {
      mode: "session";
      snapshot: SessionControlState;
      onClearQueue(): Promise<void>;
    };

/** assistant-ui Composer 与 Desktop draft/session 控制面的组合入口。 */
export function Composer(props: ComposerProps) {
  const aui = useAui();
  const [mode, setMode] = useState<"steer" | "followUp">("steer");
  const [sending, setSending] = useState(false);
  const [selectingProject, setSelectingProject] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [escapeCancelArmed, setEscapeCancelArmed] = useState(false);
  const escapeCancelTimer = useRef<number | undefined>(undefined);
  const appliedEditorRevision = useRef<{
    target: string;
    revision: number;
  } | null>(null);
  const syncedEditor = useRef<{ target: string; text: string } | null>(null);
  const suggestions = useRef<ComposerSuggestionsHandle>(null);
  const snapshot = props.mode === "session" ? props.snapshot : null;
  const materializing = props.mode === "draft" && props.phase === "materializing";
  const isRunning = useAuiState((state) => state.thread.isRunning);
  const piPhase = usePiThreadPhase();
  const isCancelable = isRunning || piPhase === "compacting" || piPhase === "tree-navigation";
  const queueCount = useAuiState((state) => state.composer.queue.length);
  const composerText = useAuiState((state) => state.composer.text);

  const clearEscapeCancelTimer = useCallback(() => {
    if (escapeCancelTimer.current === undefined) return;
    window.clearTimeout(escapeCancelTimer.current);
    escapeCancelTimer.current = undefined;
  }, []);

  useEffect(() => {
    if (!isCancelable) {
      clearEscapeCancelTimer();
      setEscapeCancelArmed(false);
    }
    return clearEscapeCancelTimer;
  }, [clearEscapeCancelTimer, isCancelable]);

  useEffect(() => {
    if (!snapshot) return;
    const target = `${snapshot.projectId}:${snapshot.threadId}`;
    const revision = snapshot.extensionUi.editorRevision;
    const applied = appliedEditorRevision.current;
    if (applied?.target === target && applied.revision === revision) return;
    appliedEditorRevision.current = { target, revision };
    const editorText = snapshot.extensionUi.editorText;
    if (editorText !== undefined && aui.composer().getState().text !== editorText) aui.composer().setText(editorText);
  }, [aui, snapshot]);

  useEffect(() => {
    if (!snapshot) return;
    const target = `${snapshot.projectId}:${snapshot.threadId}`;
    const synced = syncedEditor.current;
    if (synced?.target !== target) {
      syncedEditor.current = { target, text: composerText };
      return;
    }
    if (synced.text === composerText) return;
    syncedEditor.current = { target, text: composerText };
    void window.desktop.sessions
      .setEditorText(snapshot.projectId, snapshot.threadId, composerText)
      .catch((value: unknown) => setError(errorMessage(value)));
  }, [composerText, snapshot]);

  useAuiEvent("composer.attachmentAddError", ({ message }) => {
    setError(message);
  });

  const aboveWidgets = snapshot?.extensionUi.widgets.filter(({ placement }) => placement === "aboveEditor") ?? [];
  const belowWidgets = snapshot?.extensionUi.widgets.filter(({ placement }) => placement === "belowEditor") ?? [];
  const suggestionProjectId = props.mode === "draft" ? props.project?.id : props.snapshot.projectId;
  const commands = props.mode === "draft" ? (props.config?.commands ?? []) : props.snapshot.commands;

  const submitRunning = () => {
    if (!snapshot || aui.composer().getState().text.trim().length === 0 || sending) return;
    setSending(true);
    setError(null);
    try {
      aui.composer().send({ steer: mode === "steer" });
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setSending(false);
    }
  };

  const submitDraft = async () => {
    if (
      props.mode !== "draft" ||
      !props.project?.available ||
      !props.config?.model ||
      props.config.readiness.state !== "ready" ||
      aui.composer().getState().isEmpty ||
      sending ||
      selectingProject ||
      materializing
    )
      return;
    setSending(true);
    setError(null);
    try {
      await props.onSubmit();
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setSending(false);
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    setError(null);
    if (props.mode === "draft") {
      event.preventDefault();
      void submitDraft();
      return;
    }
    if (!isRunning) return;
    event.preventDefault();
    submitRunning();
  };

  const handleInputKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const suggestionHandled = suggestions.current?.handleKey(event.key) === true;
    if (suggestionHandled) {
      event.preventDefault();
      if (event.key !== "Escape" || !isCancelable) return;
    }
    if (!isCancelable || event.nativeEvent.isComposing) return;

    if (isRunning && event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      if (!event.repeat) submitRunning();
      return;
    }

    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return;

    if (escapeCancelTimer.current !== undefined) {
      clearEscapeCancelTimer();
      setEscapeCancelArmed(false);
      aui.composer().cancel();
      return;
    }

    setEscapeCancelArmed(true);
    escapeCancelTimer.current = window.setTimeout(() => {
      escapeCancelTimer.current = undefined;
      setEscapeCancelArmed(false);
    }, ESCAPE_CANCEL_WINDOW_MS);
  };

  const clearQueue = async () => {
    if (props.mode !== "session") return;
    try {
      await props.onClearQueue();
    } catch (value) {
      setError(errorMessage(value));
    }
  };

  const readiness = props.mode === "draft" ? props.config?.readiness : snapshot?.readiness;
  const readinessError = readiness?.state === "ready" ? null : readiness?.message;
  const configLoading = props.mode === "draft" && props.configLoading;
  const disabled = sending || selectingProject || materializing;
  const attachmentsDisabled = disabled || readiness?.state !== "ready";

  return (
    <div className="composer-wrap" data-draft-composer={props.mode === "draft" || undefined}>
      {snapshot && queueCount > 0 ? (
        <div className="queue-strip">
          <span>{queueCount} 条消息正在排队</span>
          <TextButton className="text-xs" onClick={() => void clearQueue()}>
            <RotateCcw /> 清空
          </TextButton>
        </div>
      ) : null}

      <ComposerPrimitive.Root className="relative flex w-full flex-col" onSubmit={handleSubmit}>
        <ComposerPrimitive.AttachmentDropzone asChild disabled={attachmentsDisabled}>
          <div className="relative flex w-full flex-col gap-2 rounded-(--composer-radius) border border-border/60 bg-[color-mix(in_oklab,var(--color-muted)_30%,var(--color-background))] p-(--composer-padding) shadow-[0_4px_16px_-8px_rgba(0,0,0,0.08),0_1px_2px_rgba(0,0,0,0.04)] transition-[border-color,box-shadow] focus-within:border-border focus-within:shadow-[0_6px_24px_-8px_rgba(0,0,0,0.12),0_1px_2px_rgba(0,0,0,0.05)] data-[dragging=true]:border-dashed data-[dragging=true]:border-ring">
            {suggestionProjectId && !materializing ? (
              <ComposerSuggestions ref={suggestions} projectId={suggestionProjectId} commands={commands} />
            ) : null}
            <ComposerWidgets widgets={aboveWidgets} />
            <ComposerAttachments disabled={attachmentsDisabled} />
            <ComposerPrimitive.Input
              className="caret-primary placeholder:text-muted-foreground/80 max-h-32 min-h-10 w-full resize-none bg-transparent px-2.5 py-1 text-sm leading-relaxed outline-none"
              onKeyDown={handleInputKeyDown}
              placeholder={
                props.mode === "draft"
                  ? "发送消息，@ 引用文件"
                  : isRunning
                    ? "运行中，可发送后续消息"
                    : "发送消息，@ 引用文件，/ 执行命令"
              }
              rows={1}
              maxRows={9}
              autoFocus={props.mode === "draft"}
              disabled={materializing}
              aria-label="消息输入"
            />
            <div className="flex min-h-8 items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-1">
                <ComposerAddAttachment disabled={attachmentsDisabled} />
                {props.mode === "draft" ? (
                  <ProjectSelect
                    projects={props.projects}
                    projectId={props.project?.id ?? null}
                    disabled={disabled}
                    onValueChange={(projectId) => {
                      setError(null);
                      setSelectingProject(true);
                      void props.onProjectChange(projectId).then(
                        () => setSelectingProject(false),
                        (value: unknown) => {
                          setSelectingProject(false);
                          setError(errorMessage(value));
                        },
                      );
                    }}
                  />
                ) : null}
                {isRunning ? (
                  <div className="mode-control" role="group" aria-label="运行中消息模式">
                    <button
                      type="button"
                      className={mode === "steer" ? "is-active" : ""}
                      onClick={() => setMode("steer")}
                    >
                      引导
                    </button>
                    <button
                      type="button"
                      className={mode === "followUp" ? "is-active" : ""}
                      onClick={() => setMode("followUp")}
                    >
                      排队
                    </button>
                  </div>
                ) : null}
              </div>
              <div className="flex min-w-0 items-center gap-1">
                {props.mode === "draft" ? (
                  <>
                    <ModelSelect
                      availableModels={props.config?.models ?? []}
                      model={props.config?.model}
                      disabled={disabled || configLoading}
                      onValueChange={props.onModelChange}
                    />
                    <ThinkingSelect
                      value={props.config?.thinkingLevel ?? "off"}
                      levels={props.config?.thinkingLevels ?? []}
                      disabled={disabled || configLoading}
                      onValueChange={props.onThinkingChange}
                    />
                  </>
                ) : (
                  <>
                    <ModelSelect
                      availableModels={props.snapshot.models}
                      model={props.snapshot.model}
                      onValueChange={(provider, modelId) => {
                        void window.desktop.sessions.setModel(
                          props.snapshot.projectId,
                          props.snapshot.threadId,
                          provider,
                          modelId,
                        );
                      }}
                    />
                    <ThinkingSelect
                      value={props.snapshot.thinkingLevel}
                      levels={props.snapshot.thinkingLevels}
                      onValueChange={(level) => {
                        void window.desktop.sessions.setThinking(
                          props.snapshot.projectId,
                          props.snapshot.threadId,
                          level,
                        );
                      }}
                    />
                  </>
                )}
                <ComposerSubmitControl
                  props={props}
                  disabled={disabled}
                  configLoading={configLoading}
                  sending={sending}
                  isRunning={isRunning}
                />
              </div>
            </div>
            <ComposerWidgets widgets={belowWidgets} />
          </div>
        </ComposerPrimitive.AttachmentDropzone>
      </ComposerPrimitive.Root>
      {error || readinessError ? <p className="composer-error">{error ?? readinessError}</p> : null}
    </div>
  );
}

function ComposerSubmitControl({
  props,
  disabled,
  configLoading,
  sending,
  isRunning,
}: {
  props: ComposerProps;
  disabled: boolean;
  configLoading: boolean;
  sending: boolean;
  isRunning: boolean;
}) {
  const aui = useAui();
  const isEmpty = useAuiState((state) => state.composer.isEmpty);
  const hasText = useAuiState((state) => state.composer.text.trim().length > 0);
  if (props.mode === "draft") {
    return (
      <TooltipIconButton
        type="submit"
        tooltip="发送消息"
        side="top"
        variant="default"
        className="size-7 rounded-full"
        disabled={
          disabled ||
          configLoading ||
          isEmpty ||
          !props.project?.available ||
          !props.config?.model ||
          props.config.readiness.state !== "ready"
        }
      >
        <ArrowUp className="size-4" />
      </TooltipIconButton>
    );
  }
  if (isRunning) {
    if (!hasText) {
      return (
        <TooltipIconButton
          type="button"
          tooltip="停止运行"
          side="top"
          variant="default"
          className="size-7 rounded-full"
          onClick={() => aui.composer().cancel()}
        >
          <Square className="size-4" />
        </TooltipIconButton>
      );
    }
    return (
      <TooltipIconButton
        type="submit"
        tooltip="发送后续消息"
        side="top"
        variant="default"
        className="size-7 rounded-full"
        disabled={sending || props.snapshot.readiness.state !== "ready"}
      >
        <ArrowUp className="size-4" />
      </TooltipIconButton>
    );
  }
  return (
    <ComposerPrimitive.Send asChild>
      <TooltipIconButton tooltip="发送消息" side="top" variant="default" className="size-7 rounded-full">
        <ArrowUp className="size-4" />
      </TooltipIconButton>
    </ComposerPrimitive.Send>
  );
}

function ComposerWidgets({ widgets }: { widgets: SessionControlState["extensionUi"]["widgets"] }) {
  if (widgets.length === 0) return null;
  return (
    <div className="composer-widgets">
      {widgets.map((widget) => (
        <pre key={widget.key}>{widget.lines.join("\n")}</pre>
      ))}
    </div>
  );
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
