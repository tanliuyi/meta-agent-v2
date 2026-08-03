import {
  ComposerPrimitive,
  unstable_defaultDirectiveFormatter,
  useAui,
  useAuiEvent,
  useAuiState,
} from "@assistant-ui/react";
import Command from "lucide-react/dist/esm/icons/command.mjs";
import X from "lucide-react/dist/esm/icons/x.mjs";
import { type FormEvent, useCallback, useMemo, useRef, useState } from "react";
import type { SessionControlState } from "../../../../../shared/contracts.ts";
import { errorMessage } from "../../../shared/lib/error-message.ts";
import { ComposerAddAttachment } from "../../assistant-ui/attachment/composer-add-attachment.tsx";
import { ComposerAttachments } from "../../assistant-ui/attachment/composer-attachments.tsx";
import { ModelSelect } from "../model-select.tsx";
import { ProjectSelect } from "../project-select.tsx";
import { ThinkingSelect } from "../thinking-select.tsx";
import { slashCommandAcceptsArguments, slashCommandText } from "./composer-command-trigger.tsx";
import { ComposerExtensionCommand } from "./composer-extension-command.tsx";
import { ComposerInput } from "./composer-input.tsx";
import { ComposerQueue } from "./composer-queue.tsx";
import { ComposerQuotes } from "./composer-quotes.tsx";
import { ComposerSubmitControl } from "./composer-submit-control.tsx";
import { slashCommandDisplayName } from "./composer-suggestion-model.ts";
import type { ComposerProps } from "./composer-types.ts";
import { ComposerWidgets } from "./composer-widgets.tsx";

const EMPTY_COMMANDS: SessionControlState["commands"] = [];
const EMPTY_MODELS: SessionControlState["models"] = [];
const EMPTY_THINKING_LEVELS: SessionControlState["thinkingLevels"] = [];
const EMPTY_WIDGETS: SessionControlState["extensionHost"]["widgets"] = [];

/** assistant-ui Composer 与 Desktop draft/session 控制面的低频编排入口。 */
export function Composer(props: ComposerProps) {
  const aui = useAui();
  const [mode, setMode] = useState<"steer" | "followUp">("steer");
  const [sending, setSending] = useState(false);
  const [escapeCancelPending, setEscapeCancelPending] = useState(false);
  const [selectingProject, setSelectingProject] = useState(false);
  const [selectedCommand, setSelectedCommand] = useState<SessionControlState["commands"][number] | null>(null);
  const selectedCommandRef = useRef(selectedCommand);
  const [error, setError] = useState<string | null>(null);
  const materializing = props.mode === "draft" && props.phase === "materializing";
  const isRunning = useAuiState((state) => state.thread.isRunning);
  const isCancelable =
    isRunning || (props.mode === "session" && (props.phase === "compacting" || props.phase === "tree-navigation"));
  const extensionWidgets = props.mode === "session" ? props.widgets : EMPTY_WIDGETS;
  const extensionWorking = props.mode === "session" ? props.working : undefined;
  const aboveWidgets = useMemo(
    () => extensionWidgets?.filter(({ placement }) => placement === "aboveEditor"),
    [extensionWidgets],
  );
  const belowWidgets = useMemo(
    () => extensionWidgets?.filter(({ placement }) => placement === "belowEditor"),
    [extensionWidgets],
  );
  const suggestionProjectId = props.mode === "draft" ? props.project?.id : props.projectId;
  const commands = props.mode === "draft" ? (props.config?.commands ?? EMPTY_COMMANDS) : props.commands;

  const reportError = useCallback((value: unknown) => {
    setError(errorMessage(value));
  }, []);

  const selectCommand = useCallback((command: SessionControlState["commands"][number] | null) => {
    selectedCommandRef.current = command;
    setSelectedCommand(command);
  }, []);

  const materializeSelectedCommand = useCallback(() => {
    const command = selectedCommandRef.current;
    if (!command) return;
    const args = aui.composer().getState().text;
    aui.composer().setText(slashCommandText(command, args));
    selectCommand(null);
  }, [aui, selectCommand]);

  const insertSkillDirective = useCallback(
    (command: SessionControlState["commands"][number]) => {
      const composer = aui.composer();
      const text = composer.getState().text;
      const directive = unstable_defaultDirectiveFormatter.serialize({
        id: command.name,
        type: "skill",
        label: slashCommandDisplayName(command),
      });
      const nextText = /(?:^|\s)\/[^\s]*$/.test(text)
        ? text.replace(/(?:^|\s)\/[^\s]*$/, (match) => `${match.startsWith(" ") ? " " : ""}${directive} `)
        : `${text.trimEnd()}${text.trim().length > 0 ? " " : ""}${directive} `;
      composer.setText(nextText);
    },
    [aui],
  );

  useAuiEvent("composer.attachmentAddError", ({ message }) => {
    setError(message);
  });

  const submitRunning = useCallback(() => {
    if (props.mode !== "session" || sending) return;
    materializeSelectedCommand();
    if (aui.composer().getState().text.trim().length === 0) return;
    setSending(true);
    setError(null);
    try {
      aui.composer().send({ steer: mode === "steer" });
    } catch (value) {
      reportError(value);
    } finally {
      setSending(false);
    }
  }, [aui, materializeSelectedCommand, mode, props.mode, reportError, sending]);

  const submitDraft = async () => {
    if (props.mode !== "draft") return;
    materializeSelectedCommand();
    if (
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
    if (!isRunning) {
      materializeSelectedCommand();
      return;
    }
    event.preventDefault();
    submitRunning();
  };

  const handleCommandSelect = (command: SessionControlState["commands"][number]) => {
    setError(null);
    selectCommand(null);
    if (command.source === "skill") {
      insertSkillDirective(command);
      return;
    }
    if (slashCommandAcceptsArguments(command)) {
      selectCommand(command);
      return;
    }

    aui.composer().setText(slashCommandText(command, ""));
    if (props.mode === "draft") void submitDraft();
    else if (isRunning) submitRunning();
    else aui.composer().send();
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

      <ComposerPrimitive.Unstable_TriggerPopoverRoot>
        <ComposerPrimitive.Root className="relative flex w-full flex-col" onSubmit={handleSubmit}>
          <ComposerPrimitive.AttachmentDropzone asChild disabled={attachmentsDisabled}>
            <div className="composer-surface relative flex w-full flex-col gap-2 rounded-(--composer-radius) border border-border/60 bg-(--composer-background) p-(--composer-padding) shadow-(--elevation-composer) transition-[border-color,box-shadow] focus-within:border-border focus-within:shadow-(--elevation-composer-focus) data-[dragging=true]:border-dashed data-[dragging=true]:border-ring">
              <ComposerQuotes />
              {isRunning && extensionWorking?.message && extensionWorking.visible !== false ? (
                <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground" role="status">
                  <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-current" aria-hidden="true" />
                  <span className="min-w-0 truncate">{extensionWorking.message}</span>
                </div>
              ) : null}
              <ComposerWidgets widgets={aboveWidgets} />
              <ComposerAttachments disabled={attachmentsDisabled} />
              <ComposerInput
                projectId={suggestionProjectId}
                commands={commands}
                mode={props.mode}
                isRunning={isRunning}
                isCancelable={isCancelable}
                materializing={materializing}
                onCommandSelect={handleCommandSelect}
                onSubmit={
                  props.mode === "draft"
                    ? () => void submitDraft()
                    : () => {
                        materializeSelectedCommand();
                        aui.composer().send();
                      }
                }
                onSubmitRunning={submitRunning}
                onEscapeCancelPendingChange={setEscapeCancelPending}
              />
              <div className="composer-toolbar flex min-h-8 items-center justify-between gap-2">
                <div className="composer-toolbar-start flex min-w-0 items-center gap-2">
                  <ComposerAddAttachment disabled={attachmentsDisabled} />
                  {selectedCommand ? (
                    <div className="min-w-0 border-l border-border/70 pl-1">
                      <div className="group flex h-6 min-w-0 items-center gap-1 rounded-xl px-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-within:bg-accent focus-within:text-accent-foreground">
                        <button
                          type="button"
                          aria-label={`移除命令 ${slashCommandDisplayName(selectedCommand)}`}
                          className="relative flex flex-row items-center justify-center size-3.5 shrink-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                          onClick={() => selectCommand(null)}
                        >
                          <Command
                            aria-hidden="true"
                            className="absolute inset-0 size-3.5 transition-opacity group-hover:opacity-0 group-focus-within:opacity-0"
                          />
                          <span className="absolute inset-0 flex size-3.5 items-center justify-center rounded-full bg-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                            <X aria-hidden="true" className="size-3 text-background" />
                          </span>
                        </button>
                        <span className="max-w-40 truncate">{slashCommandDisplayName(selectedCommand)}</span>
                      </div>
                    </div>
                  ) : null}
                  {props.mode === "draft" && !props.fixedProject ? (
                    <ProjectSelect
                      className="max-w-36 project-select-trigger"
                      projects={props.projects}
                      projectId={props.project?.id ?? null}
                      disabled={disabled}
                      onValueChange={(projectId) => {
                        setError(null);
                        selectCommand(null);
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
                    <div className="mode-control shrink-0" role="group" aria-label="运行中消息模式">
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
                <div className="composer-toolbar-end flex min-w-0 flex-1 items-center justify-end gap-2">
                  {props.mode === "draft" ? (
                    <>
                      <ModelSelect
                        availableModels={props.config?.models ?? EMPTY_MODELS}
                        model={props.config?.model}
                        disabled={disabled || configLoading}
                        loading={configLoading}
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
                        loading={props.modelsLoading}
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
                    escapeCancelPending={escapeCancelPending}
                    loading={props.mode === "draft" && (sending || materializing)}
                  />
                </div>
              </div>
              <ComposerWidgets widgets={belowWidgets} />
            </div>
          </ComposerPrimitive.AttachmentDropzone>
        </ComposerPrimitive.Root>
      </ComposerPrimitive.Unstable_TriggerPopoverRoot>
      {error || readinessError ? (
        <p className="composer-error" role="status" aria-live="polite">
          {error ?? readinessError}
        </p>
      ) : null}
    </div>
  );
}
