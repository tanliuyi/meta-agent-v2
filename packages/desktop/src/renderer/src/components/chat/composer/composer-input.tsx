import { ComposerPrimitive, unstable_useTriggerPopoverAriaProps, useAui, useAuiState } from "@assistant-ui/react";
import { LexicalComposerInput } from "@assistant-ui/react-lexical";
import {
  type ClipboardEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { SlashCommand } from "../../../../../shared/contracts.ts";
import { ComposerDirectiveChip } from "../../assistant-ui/composer-directive-chip.tsx";
import { ComposerCommandTrigger } from "./composer-command-trigger.tsx";
import { ComposerFileTrigger } from "./composer-file-trigger.tsx";

const ESCAPE_CANCEL_WINDOW_MS = 1_000;

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
  mode: "draft" | "session";
  isRunning: boolean;
  isCancelable: boolean;
  materializing: boolean;
  onCommandSelect(command: SlashCommand): void;
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
  mode,
  isRunning,
  isCancelable,
  materializing,
  onCommandSelect,
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
  const triggerAria = unstable_useTriggerPopoverAriaProps();
  const [fileTriggerOpen, setFileTriggerOpen] = useState(false);
  const [commandTriggerOpen, setCommandTriggerOpen] = useState(false);

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
    if (materializing) setCommandTriggerOpen(false);
  }, [materializing, projectId]);

  const disabled = materializing || runtimeDisabled;
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
    if (
      (fileTriggerOpen || commandTriggerOpen) &&
      (event.key === "ArrowDown" ||
        event.key === "ArrowUp" ||
        event.key === "Enter" ||
        event.key === "Tab" ||
        event.key === "Escape" ||
        event.key === "Backspace")
    )
      return;

    if (event.nativeEvent.isComposing) return;

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
      <ComposerCommandTrigger commands={commands} onSelect={onCommandSelect} onOpenChange={setCommandTriggerOpen} />
      <LexicalComposerInput
        ref={editorRef}
        className="caret-primary text-foreground max-h-32 min-h-10 w-full bg-transparent px-1 py-1 text-sm leading-relaxed outline-none [&_.aui-lexical-input]:min-h-8 [&_.aui-lexical-input]:outline-none"
        submitMode="none"
        cancelOnEscape={false}
        directiveChip={ComposerDirectiveChip}
        onKeyDownCapture={handleInputKeyDown}
        onPasteCapture={handleInputPaste}
        placeholder={
          mode === "draft"
            ? "发送消息，@ 引用文件"
            : isRunning
              ? "运行中，可发送后续消息"
              : "发送消息，@ 引用文件，/ 执行命令"
        }
        autoFocus={mode === "draft"}
      />
    </>
  );
}
