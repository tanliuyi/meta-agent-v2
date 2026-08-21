import {
  ComposerPrimitive,
  unstable_defaultDirectiveFormatter,
  useAui,
  useAuiEvent,
  useAuiState,
} from "@assistant-ui/react";
import Command from "lucide-react/dist/esm/icons/command.mjs";
import X from "lucide-react/dist/esm/icons/x.mjs";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Readiness, SessionControlState } from "../../../../../shared/contracts.ts";
import {
  appendComposerQuote,
  type ComposerQuoteTarget,
  getComposerQuotes,
  removeComposerQuoteByMessageId,
  updateComposerQuoteText,
} from "../../../runtime/composer-quotes.ts";
import { errorMessage } from "../../../shared/lib/error-message.ts";
import {
  BrowserAnnotationSubmitTracker,
  subscribeBrowserAnnotationToComposer,
} from "../../../state/browser-composer-bridge.ts";
import { ComposerAddAttachment } from "../../assistant-ui/attachment/composer-add-attachment.tsx";
import { ComposerAttachments } from "../../assistant-ui/attachment/composer-attachments.tsx";
import { useSessionScope } from "../../session-context.tsx";
import { ModelSelect } from "../model-select.tsx";
import { ProjectSelect } from "../project-select.tsx";
import { ThinkingSelect } from "../thinking-select.tsx";
import { slashCommandAcceptsArguments, slashCommandText } from "./composer-command-trigger.tsx";
import { ComposerContextUsage } from "./composer-context-usage.tsx";
import { ComposerExtensionCommand } from "./composer-extension-command.tsx";
import { ComposerFeedback } from "./composer-feedback.tsx";
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
  const { record } = useSessionScope();
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

  // 浏览器面板保存标注后：作为用户引用（quote）追加到 composer；面板的
  // 编辑/删除/页面切换同步到 composer 中同 messageId 的引用（保持原 ID）。
  useEffect(() => {
    return subscribeBrowserAnnotationToComposer(record.key, (event) => {
      const composer = aui.composer() as ComposerQuoteTarget;
      if (!composer || typeof composer.setQuote !== "function") return;
      if (event.type === "add") appendComposerQuote(composer, event.payload);
      else if (event.type === "update") updateComposerQuoteText(composer, event.messageId, event.text);
      else removeComposerQuoteByMessageId(composer, event.messageId);
    });
  }, [aui, record.key]);

  // 本次 prompt 成功发送（composer.send 事件）前已消费的浏览器标注引用：
  // send 成功构建 outgoing message 后才同步发 send 事件（上传失败恢复 quote 且不发
  // 事件），因此在此消费即“发送成功才清理、失败保留”的边界。每次提交入口在触发
  // send 前快照当前 quote 中的 browser-annotation 引用（quote 在 send 内部同步清空，
  // 事件载荷不含 quote）。
  // ref 内记录创建时的 key：record.key 变化时重建 tracker，避免沿用旧会话的 targetKey。
  const browserAnnotationSubmitTrackerRef = useRef<{
    key: string;
    tracker: BrowserAnnotationSubmitTracker;
  } | null>(null);
  const browserAnnotationSubmitTracker = useCallback(() => {
    const existing = browserAnnotationSubmitTrackerRef.current;
    if (existing && existing.key === record.key) return existing.tracker;
    const tracker = new BrowserAnnotationSubmitTracker(record.key);
    browserAnnotationSubmitTrackerRef.current = { key: record.key, tracker };
    return tracker;
  }, [record.key]);
  const snapshotBrowserAnnotationQuotes = useCallback(() => {
    const composer = aui.composer() as ComposerQuoteTarget;
    if (!composer || typeof composer.getState !== "function") return;
    browserAnnotationSubmitTracker().snapshot(getComposerQuotes(composer.getState().quote));
  }, [aui, browserAnnotationSubmitTracker]);

  useAuiEvent("composer.send", () => {
    browserAnnotationSubmitTracker().onSend();
  });

  const submitRunning = useCallback(() => {
    if (props.mode !== "session" || sending) return;
    materializeSelectedCommand();
    if (aui.composer().getState().text.trim().length === 0) return;
    setSending(true);
    setError(null);
    try {
      snapshotBrowserAnnotationQuotes();
      aui.composer().send({ steer: mode === "steer" });
    } catch (value) {
      reportError(value);
    } finally {
      setSending(false);
    }
  }, [aui, materializeSelectedCommand, mode, props.mode, reportError, sending, snapshotBrowserAnnotationQuotes]);

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
      // draft 的 Enter/命令/表单提交共用本路径：readiness 校验通过后、真正发送前快照。
      snapshotBrowserAnnotationQuotes();
      await props.onSubmit();
      // 生产上 onSubmit 直接 materializeDraftSession（sessions.prompt），不经过
      // assistant-ui composer.send；成功返回即发送成功，立即按快照消费标注引用。
      browserAnnotationSubmitTracker().onSend();
    } catch (value) {
      // 失败不消费：引用保留在 composer，重试时 snapshot 替换 pending。
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
      // 不 preventDefault：ComposerPrimitive.Root 的内部 send 随后同步执行。
      snapshotBrowserAnnotationQuotes();
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
    else {
      snapshotBrowserAnnotationQuotes();
      aui.composer().send();
    }
  };

  const readiness = props.mode === "draft" ? props.config?.readiness : props.readiness;
  const readinessFeedback = readiness ? getReadinessFeedback(readiness) : null;
  const configLoading = props.mode === "draft" && props.configLoading;
  const disabled = sending || selectingProject || materializing || (props.mode === "session" && !props.commandsReady);
  const attachmentsDisabled = disabled || readiness?.state !== "ready";
  const draftOptionsInDrawer = props.mode === "draft" && !props.fixedProject;
  const draftSelectionControls =
    props.mode === "draft" ? (
      <>
        {!props.fixedProject ? (
          <ProjectSelect
            className="project-select-trigger max-w-56"
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
      </>
    ) : null;

  return (
    <div className="composer-wrap" data-draft-composer={props.mode === "draft" || undefined}>
      {props.mode === "session" ? (
        <ComposerExtensionCommand
          projectId={props.projectId}
          threadId={props.threadId}
          command={props.composerCommand}
        />
      ) : null}
      {props.mode === "session" ? <ComposerQueue items={props.queue} /> : null}

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
                        snapshotBrowserAnnotationQuotes();
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
                  {!draftOptionsInDrawer ? draftSelectionControls : null}
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
                  {props.mode === "session" ? <ComposerContextUsage usage={props.context} /> : null}
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
      {draftOptionsInDrawer ? (
        <div className="draft-composer-drawer" role="group" aria-label="新会话设置">
          <div className="draft-composer-drawer-content">{draftSelectionControls}</div>
        </div>
      ) : null}
      {error || readinessFeedback ? (
        <div className="composer-feedback-stack">
          {error ? <ComposerFeedback tone="error" message={error} /> : null}
          {!error && readinessFeedback ? (
            <ComposerFeedback tone={readinessFeedback.tone} message={readinessFeedback.message} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function getReadinessFeedback(readiness: Readiness): {
  tone: "warning" | "error";
  message: string;
} | null {
  if (readiness.state === "ready") return null;
  if (readiness.state === "missing-model") {
    return {
      tone: "warning",
      message: readiness.message ?? "请先配置一个可用模型。",
    };
  }
  if (readiness.state === "missing-credentials") {
    return {
      tone: "error",
      message: readiness.message ?? "请先配置模型凭据后再发送。",
    };
  }
  return {
    tone: "error",
    message: readiness.message ?? "请选择其他可用模型后再发送。",
  };
}
