import { ComposerPrimitive, useAui } from "@assistant-ui/react";
import { type KeyboardEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import type { SlashCommand } from "../../../../shared/contracts.ts";
import {
  ComposerSuggestions,
  type ComposerSuggestionsHandle,
  type ComposerSuggestionsState,
} from "./composer-suggestions.tsx";

const ESCAPE_CANCEL_WINDOW_MS = 1_000;
const CLOSED_SUGGESTIONS: ComposerSuggestionsState = { expanded: false, activeDescendant: undefined };

interface ComposerInputProps {
  projectId: string | undefined;
  commands: readonly SlashCommand[];
  mode: "draft" | "session";
  isRunning: boolean;
  isCancelable: boolean;
  materializing: boolean;
  onSubmitRunning(): void;
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
  onSubmitRunning,
}: ComposerInputProps) {
  const aui = useAui();
  const suggestions = useRef<ComposerSuggestionsHandle>(null);
  const escapeCancelTimer = useRef<number | undefined>(undefined);
  const listboxId = `${useId()}-suggestions`;
  const [suggestionState, setSuggestionState] = useState<ComposerSuggestionsState>(CLOSED_SUGGESTIONS);

  const updateSuggestionState = useCallback((next: ComposerSuggestionsState) => {
    setSuggestionState((current) =>
      current.expanded === next.expanded && current.activeDescendant === next.activeDescendant ? current : next,
    );
  }, []);

  const clearEscapeCancelTimer = useCallback(() => {
    if (escapeCancelTimer.current === undefined) return;
    window.clearTimeout(escapeCancelTimer.current);
    escapeCancelTimer.current = undefined;
  }, []);

  useEffect(() => {
    if (!isCancelable) clearEscapeCancelTimer();
    return clearEscapeCancelTimer;
  }, [clearEscapeCancelTimer, isCancelable]);

  useEffect(() => {
    if (!projectId || materializing) setSuggestionState(CLOSED_SUGGESTIONS);
  }, [materializing, projectId]);

  const handleInputKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const suggestionHandled = suggestions.current?.handleKey(event.key) === true;
    if (suggestionHandled) {
      event.preventDefault();
      if (event.key !== "Escape" || !isCancelable) return;
    }
    if (!isCancelable || event.nativeEvent.isComposing) return;

    if (isRunning && event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      if (!event.repeat) onSubmitRunning();
      return;
    }

    if (event.key !== "Escape") return;
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
    }, ESCAPE_CANCEL_WINDOW_MS);
  };

  return (
    <>
      {projectId && !materializing ? (
        <ComposerSuggestions
          ref={suggestions}
          listboxId={listboxId}
          projectId={projectId}
          commands={commands}
          onStateChange={updateSuggestionState}
        />
      ) : null}
      <ComposerPrimitive.Input
        className="caret-primary placeholder:text-muted-foreground/80 max-h-32 min-h-10 w-full resize-none bg-transparent px-2.5 py-1 text-sm leading-relaxed outline-none"
        onKeyDown={handleInputKeyDown}
        placeholder={
          mode === "draft"
            ? "发送消息，@ 引用文件"
            : isRunning
              ? "运行中，可发送后续消息"
              : "发送消息，@ 引用文件，/ 执行命令"
        }
        rows={1}
        maxRows={9}
        autoFocus={mode === "draft"}
        disabled={materializing}
        role="combobox"
        aria-label="消息输入"
        aria-autocomplete="list"
        aria-haspopup="listbox"
        aria-controls={listboxId}
        aria-expanded={suggestionState.expanded}
        aria-activedescendant={suggestionState.activeDescendant}
      />
    </>
  );
}
