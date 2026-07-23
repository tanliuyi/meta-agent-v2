import { ComposerPrimitive, useAui, useAuiEvent, useAuiState } from "@assistant-ui/react";
import { type FormEvent, useCallback, useMemo, useState } from "react";
import type { SessionControlState } from "../../../../shared/contracts.ts";
import { errorMessage } from "../../shared/lib/error-message.ts";
import { ComposerAddAttachment } from "../assistant-ui/attachment/composer-add-attachment.tsx";
import { ComposerAttachments } from "../assistant-ui/attachment/composer-attachments.tsx";
import { ComposerExtensionCommand } from "./composer-extension-command.tsx";
import { ComposerInput } from "./composer-input.tsx";
import { ComposerQueue } from "./composer-queue.tsx";
import { ComposerSubmitControl } from "./composer-submit-control.tsx";
import type { ComposerProps } from "./composer-types.ts";
import { ComposerWidgets } from "./composer-widgets.tsx";
import { ModelSelect } from "./model-select.tsx";
import { ProjectSelect } from "./project-select.tsx";
import { ThinkingSelect } from "./thinking-select.tsx";

const EMPTY_COMMANDS: SessionControlState["commands"] = [];
const EMPTY_MODELS: SessionControlState["models"] = [];
const EMPTY_THINKING_LEVELS: SessionControlState["thinkingLevels"] = [];
const EMPTY_WIDGETS: SessionControlState["extensionHost"]["widgets"] = [];

/** assistant-ui Composer 与 Desktop draft/session 控制面的低频编排入口。 */
export function Composer(props: ComposerProps) {
  const aui = useAui();
  const [mode, setMode] = useState<"steer" | "followUp">("steer");
  const [sending, setSending] = useState(false);
  const [selectingProject, setSelectingProject] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const materializing = props.mode === "draft" && props.phase === "materializing";
  const isRunning = useAuiState((state) => state.thread.isRunning);
  const isCancelable =
    isRunning || (props.mode === "session" && (props.phase === "compacting" || props.phase === "tree-navigation"));
  const extensionWidgets = props.mode === "session" ? props.widgets : EMPTY_WIDGETS;
  const aboveWidgets = useMemo(
    () => extensionWidgets.filter(({ placement }) => placement === "aboveEditor"),
    [extensionWidgets],
  );
  const belowWidgets = useMemo(
    () => extensionWidgets.filter(({ placement }) => placement === "belowEditor"),
    [extensionWidgets],
  );
  const suggestionProjectId = props.mode === "draft" ? props.project?.id : props.projectId;
  const commands = props.mode === "draft" ? (props.config?.commands ?? EMPTY_COMMANDS) : props.commands;

  const reportError = useCallback((value: unknown) => {
    setError(errorMessage(value));
  }, []);

  useAuiEvent("composer.attachmentAddError", ({ message }) => {
    setError(message);
  });

  const submitRunning = useCallback(() => {
    if (props.mode !== "session" || aui.composer().getState().text.trim().length === 0 || sending) return;
    setSending(true);
    setError(null);
    try {
      aui.composer().send({ steer: mode === "steer" });
    } catch (value) {
      reportError(value);
    } finally {
      setSending(false);
    }
  }, [aui, mode, props.mode, reportError, sending]);

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
      reportError(value);
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

  const readiness = props.mode === "draft" ? props.config?.readiness : props.readiness;
  const readinessError = readiness?.state === "ready" ? null : readiness?.message;
  const configLoading = props.mode === "draft" && props.configLoading;
  const disabled = sending || selectingProject || materializing || (props.mode === "session" && !props.commandsReady);
  const attachmentsDisabled = disabled || readiness?.state !== "ready";

  return (
    <div className="composer-wrap" data-draft-composer={props.mode === "draft" || undefined}>
      {props.mode === "session" ? (
        <ComposerExtensionCommand
          projectId={props.projectId}
          threadId={props.threadId}
          command={props.composerCommand}
        />
      ) : null}
      {props.mode === "session" ? (
        <ComposerQueue
          items={props.queue}
          disabled={!props.commandsReady}
          onClear={props.onClearQueue}
          onError={reportError}
        />
      ) : null}

      <ComposerPrimitive.Root className="relative flex w-full flex-col" onSubmit={handleSubmit}>
        <ComposerPrimitive.AttachmentDropzone asChild disabled={attachmentsDisabled}>
          <div className="relative flex w-full flex-col gap-2 rounded-(--composer-radius) border border-border/60 bg-(--composer-background) p-(--composer-padding) shadow-(--elevation-composer) transition-[border-color,box-shadow] focus-within:border-border focus-within:shadow-(--elevation-composer-focus) data-[dragging=true]:border-dashed data-[dragging=true]:border-ring">
            <ComposerWidgets widgets={aboveWidgets} />
            <ComposerAttachments disabled={attachmentsDisabled} />
            <ComposerInput
              projectId={suggestionProjectId}
              commands={commands}
              mode={props.mode}
              isRunning={isRunning}
              isCancelable={isCancelable}
              materializing={materializing}
              onSubmitRunning={submitRunning}
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
                          reportError(value);
                        },
                      );
                    }}
                  />
                ) : null}
                {isRunning ? (
                  <div className="mode-control" role="group" aria-label="运行中消息模式">
                    <button
                      type="button"
                      aria-pressed={mode === "steer"}
                      data-state={mode === "steer" ? "on" : "off"}
                      onClick={() => setMode("steer")}
                    >
                      引导
                    </button>
                    <button
                      type="button"
                      aria-pressed={mode === "followUp"}
                      data-state={mode === "followUp" ? "on" : "off"}
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
                      availableModels={props.config?.models ?? EMPTY_MODELS}
                      model={props.config?.model}
                      disabled={disabled || configLoading}
                      onValueChange={props.onModelChange}
                    />
                    <ThinkingSelect
                      value={props.config?.thinkingLevel ?? "off"}
                      levels={props.config?.thinkingLevels ?? EMPTY_THINKING_LEVELS}
                      disabled={disabled || configLoading}
                      onValueChange={props.onThinkingChange}
                    />
                  </>
                ) : (
                  <>
                    <ModelSelect
                      availableModels={props.models}
                      model={props.model}
                      disabled={disabled || props.phase !== "idle"}
                      onOpen={() => {
                        setError(null);
                        void props.onRefreshModels().catch(reportError);
                      }}
                      onValueChange={(provider, modelId) => {
                        setError(null);
                        void props.onSetModel(provider, modelId).catch(reportError);
                      }}
                    />
                    <ThinkingSelect
                      value={props.thinkingLevel}
                      levels={props.thinkingLevels}
                      disabled={disabled || props.phase !== "idle"}
                      onValueChange={(level) => {
                        setError(null);
                        void props.onSetThinking(level).catch(reportError);
                      }}
                    />
                  </>
                )}
                <ComposerSubmitControl
                  composer={props}
                  disabled={disabled}
                  configLoading={configLoading}
                  sending={sending}
                  isRunning={isRunning}
                  loading={props.mode === "draft" && (sending || materializing)}
                />
              </div>
            </div>
            <ComposerWidgets widgets={belowWidgets} />
          </div>
        </ComposerPrimitive.AttachmentDropzone>
      </ComposerPrimitive.Root>
      {error || readinessError ? (
        <p className="composer-error" role="status" aria-live="polite">
          {error ?? readinessError}
        </p>
      ) : null}
    </div>
  );
}
