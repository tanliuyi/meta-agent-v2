import {
  ComposerPrimitive,
  unstable_useTriggerPopoverAriaProps,
  unstable_useTriggerPopoverTriggers,
  useAui,
  useAuiState,
} from "@assistant-ui/react";
import { LexicalComposerInput } from "@assistant-ui/react-lexical";
import {
  type ClipboardEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { SlashCommand } from "../../../../../shared/contracts.ts";
import { ComposerDirectiveChip } from "../../assistant-ui/composer-directive-chip.tsx";
import { ComposerCommandTrigger, slashCommandText } from "./composer-command-trigger.tsx";
import { ComposerFileTrigger } from "./composer-file-trigger.tsx";
import { composerCommandTriggerScope } from "./composer-suggestion-model.ts";
import type { ComposerTriggerStateSnapshot } from "./composer-trigger-state.tsx";

const ESCAPE_CANCEL_WINDOW_MS = 1_000;

interface CommandTriggerKeyboardResource {
  handleKeyDown(event: { readonly key: string; readonly shiftKey: boolean; preventDefault(): void }): boolean;
}

export function acceptHighlightedCommandOnSpace(
  event: Pick<
    KeyboardEvent<HTMLDivElement>,
    "key" | "shiftKey" | "ctrlKey" | "metaKey" | "altKey" | "preventDefault" | "stopPropagation"
  >,
  commandTriggerOpen: boolean,
  resource: CommandTriggerKeyboardResource | undefined,
): boolean {
  if (
    !commandTriggerOpen ||
    event.key !== " " ||
    event.shiftKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    !resource
  ) {
    return false;
  }
  const consumed = resource.handleKeyDown({
    key: "Enter",
    shiftKey: false,
    preventDefault: () => event.preventDefault(),
  });
  if (consumed) event.stopPropagation();
  return consumed;
}

interface FocusedComposerInputState {
  disabled: boolean;
  controls?: string;
  activeDescendant?: string;
  expanded: boolean;
}

export function syncFocusedComposerInput(element: HTMLElement, state: FocusedComposerInputState): void {
  element.setAttribute("role", "combobox");
  element.setAttribute("aria-label", "消息输入");
  element.setAttribute("aria-autocomplete", "list");
  element.setAttribute("aria-haspopup", "listbox");
  element.setAttribute("aria-expanded", String(state.expanded));
  element.setAttribute("aria-disabled", String(state.disabled));
  element.setAttribute("contenteditable", String(!state.disabled));
  syncOptionalAttribute(element, "aria-controls", state.controls);
  syncOptionalAttribute(element, "aria-activedescendant", state.activeDescendant);
}

function syncOptionalAttribute(element: HTMLElement, name: string, value: string | undefined): void {
  if (value === undefined) element.removeAttribute(name);
  else element.setAttribute(name, value);
}

interface ComposerInputProps {
  projectId: string | undefined;
  commands: readonly SlashCommand[];
  selectedCommand: SlashCommand | null;
  mode: "draft" | "session";
  isRunning: boolean;
  isCancelable: boolean;
  materializing: boolean;
  onCommandSelect(command: SlashCommand): void;
  onCommandClear(): void;
  onSubmit(): void;
  onSubmitRunning(): void;
  onEscapeCancelPendingChange(pending: boolean): void;
}

/**
 * 隔离 textarea、建议列表和高频键盘状态。
 * 只有该输入子树响应补全文本变化，Composer 编排层不订阅 composer.text。
 */
export function ComposerInput({
  projectId,
  commands,
  selectedCommand,
  mode,
  isRunning,
  isCancelable,
  materializing,
  onCommandSelect,
  onCommandClear,
  onSubmit,
  onSubmitRunning,
  onEscapeCancelPendingChange,
}: ComposerInputProps) {
  const aui = useAui();
  const editorRef = useRef<HTMLDivElement>(null);
  const escapeCancelTimer = useRef<number | undefined>(undefined);
  const runtimeDisabled = useAuiState(
    (state) => state.thread.isDisabled || state.composer.dictation?.inputDisabled === true,
  );
  const composerText = useAuiState((state) => state.composer.text);
  const triggerAria = unstable_useTriggerPopoverAriaProps();
  const triggers = unstable_useTriggerPopoverTriggers();
  const commandTriggerResource = triggers.get("/")?.resource;
  const [fileTriggerOpen, setFileTriggerOpen] = useState(false);
  const [commandTriggerOpen, setCommandTriggerOpen] = useState(false);
  const [dismissedCommandText, setDismissedCommandText] = useState<string | null>(null);

  const clearEscapeCancelTimer = useCallback(() => {
    if (escapeCancelTimer.current !== undefined) window.clearTimeout(escapeCancelTimer.current);
    escapeCancelTimer.current = undefined;
    onEscapeCancelPendingChange(false);
  }, [onEscapeCancelPendingChange]);

  useEffect(() => {
    if (!isCancelable) clearEscapeCancelTimer();
    return clearEscapeCancelTimer;
  }, [clearEscapeCancelTimer, isCancelable]);

  useEffect(() => {
    if (!projectId || materializing) setFileTriggerOpen(false);
    if (materializing) setCommandTriggerState({ open: false, hasItems: false });
  }, [materializing, projectId]);

  useEffect(() => {
    if (dismissedCommandText !== null && dismissedCommandText !== composerText) setDismissedCommandText(null);
  }, [composerText, dismissedCommandText]);

  const disabled = materializing || runtimeDisabled;
  const dematerializeSelectedCommand = () => {
    if (selectedCommand) {
      const text = slashCommandText(selectedCommand, aui.composer().getState().text);
      setDismissedCommandText(text);
      setCommandTriggerOpen(false);
      aui.composer().setText(text);
    }
    onCommandClear();
    editorRef.current?.querySelector<HTMLElement>(".aui-lexical-input")?.focus();
  };
  const ariaControls = triggerAria["aria-controls"];
  const ariaActiveDescendant = triggerAria["aria-activedescendant"];
  const ariaExpanded = triggerAria["aria-expanded"] === true;
  useLayoutEffect(() => {
    const input = editorRef.current?.querySelector<HTMLElement>(".aui-lexical-input");
    if (!input) return;
    syncFocusedComposerInput(input, {
      disabled,
      controls: ariaControls,
      activeDescendant: ariaActiveDescendant,
      expanded: ariaExpanded,
    });
  }, [ariaActiveDescendant, ariaControls, ariaExpanded, disabled]);

  const handleInputKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (materializing) {
      event.preventDefault();
      return;
    }
    if (shouldDeferComposerKeyToTrigger(event.key, fileTriggerOpen || commandTriggerOpen)) return;

    if (event.nativeEvent.isComposing) return;

    if (acceptHighlightedCommandOnSpace(event, commandTriggerOpen, commandTriggerResource)) return;

    const exitsEmptyCommand =
      selectedCommand &&
      aui.composer().getState().text.length === 0 &&
      (event.key === "Backspace" ||
        (event.key === " " && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey));
    if (exitsEmptyCommand) {
      event.preventDefault();
      event.stopPropagation();
      dematerializeSelectedCommand();
      return;
    }

    if (isRunning && event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      event.stopPropagation();
      event.nativeEvent.stopImmediatePropagation();
      if (!event.repeat) onSubmitRunning();
      return;
    }

    if (!isRunning && event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      event.stopPropagation();
      event.nativeEvent.stopImmediatePropagation();
      if (!event.repeat) onSubmit();
      return;
    }

    if (!isCancelable || event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return;

    if (escapeCancelTimer.current !== undefined) {
      clearEscapeCancelTimer();
      aui.composer().cancel();
      return;
    }

    escapeCancelTimer.current = window.setTimeout(() => {
      escapeCancelTimer.current = undefined;
      onEscapeCancelPendingChange(false);
    }, ESCAPE_CANCEL_WINDOW_MS);
    onEscapeCancelPendingChange(true);
  };

  const handleInputPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    if (materializing) {
      event.preventDefault();
      return;
    }
    const files = Array.from(event.clipboardData.files);
    if (!aui.thread().getState().capabilities.attachments || files.length === 0) return;

    event.preventDefault();
    void Promise.all(files.map((file) => aui.composer().addAttachment(file))).catch((error: unknown) => {
      console.error("Unable to add pasted attachment", error);
    });
  };

  return (
    <>
      {projectId && !materializing ? (
        <ComposerFileTrigger projectId={projectId} onOpenChange={setFileTriggerOpen} />
      ) : null}
      {dismissedCommandText === composerText ? null : (
        <ComposerCommandTrigger commands={commands} onSelect={onCommandSelect} onOpenChange={setCommandTriggerOpen} />
      )}
      <div className="composer-input-row">
        {selectedCommand ? (
          <button
            type="button"
            className="composer-command-prefix"
            aria-label={`移除命令 /${selectedCommand.name}`}
            title={`移除命令 /${selectedCommand.name}`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={dematerializeSelectedCommand}
          >
            <span className="composer-command-prefix-label">/{selectedCommand.name}</span>
          </button>
        ) : null}
        <LexicalComposerInput
          ref={editorRef}
          className="caret-primary text-foreground max-h-32 min-h-10 w-full bg-transparent px-1 py-1 text-sm leading-relaxed outline-none [&_.aui-lexical-input]:min-h-8 [&_.aui-lexical-input]:outline-none"
          submitMode="none"
          cancelOnEscape={false}
          directiveChip={ComposerDirectiveChip}
          onKeyDownCapture={handleInputKeyDown}
          onPasteCapture={handleInputPaste}
          placeholder={
            selectedCommand
              ? (selectedCommand.description ?? "输入命令参数")
              : mode === "draft"
                ? "发送消息，@ 引用文件"
                : isRunning
                  ? "运行中，可发送后续消息"
                  : "发送消息，@ 引用文件，/ 执行命令"
          }
          autoFocus={mode === "draft"}
        />
      </div>
    </>
  );
}
