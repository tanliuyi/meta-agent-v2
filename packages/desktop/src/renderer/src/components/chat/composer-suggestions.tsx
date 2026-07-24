import { useAui, useAuiState } from "@assistant-ui/react";
import TerminalSquare from "lucide-react/dist/esm/icons/square-terminal.mjs";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { SlashCommand } from "../../../../shared/contracts.ts";
import {
  commandSuggestions,
  composerCompletionContext,
  composerSuggestionOptionId,
  scrollSelectedSuggestion,
} from "./composer-suggestion-model.ts";

export interface ComposerSuggestionsHandle {
  handleKey(key: string): boolean;
}

export interface ComposerSuggestionsState {
  expanded: boolean;
  activeDescendant: string | undefined;
}

interface ComposerSuggestionsProps {
  listboxId: string;
  commands: readonly SlashCommand[];
  onStateChange(state: ComposerSuggestionsState): void;
}

/** Provides Pi slash-command completion; file completion uses ComposerFileTrigger. */
export const ComposerSuggestions = forwardRef<ComposerSuggestionsHandle, ComposerSuggestionsProps>(
  function ComposerSuggestions({ listboxId, commands, onStateChange }, ref) {
    const aui = useAui();
    const text = useAuiState((state) => state.composer.text);
    const context = useMemo(() => composerCompletionContext(text), [text]);
    const commandContext = context?.type === "command" ? context : null;
    const [selected, setSelected] = useState(0);
    const [dismissedText, setDismissedText] = useState<string | null>(null);
    const list = useRef<HTMLDivElement>(null);

    const items = useMemo(
      () => (commandContext ? commandSuggestions(commands, commandContext.query) : []),
      [commandContext, commands],
    );
    const visibleItems = dismissedText === text ? [] : items;
    const activeIndex = Math.min(selected, visibleItems.length - 1);
    const activeDescendant = activeIndex >= 0 ? composerSuggestionOptionId(listboxId, activeIndex) : undefined;

    useEffect(() => setSelected(0), [commandContext?.query]);
    useEffect(() => {
      if (dismissedText !== null && dismissedText !== text) setDismissedText(null);
    }, [dismissedText, text]);
    useEffect(() => scrollSelectedSuggestion(list.current), [activeIndex, visibleItems]);
    useEffect(() => {
      onStateChange({ expanded: visibleItems.length > 0, activeDescendant });
    }, [activeDescendant, onStateChange, visibleItems.length]);

    const accept = (index: number) => {
      const item = visibleItems[index];
      if (!item || !commandContext) return false;
      aui.composer().setText(`${text.slice(0, commandContext.start)}${item.text}`);
      return true;
    };

    useImperativeHandle(ref, () => ({
      handleKey(key) {
        if (visibleItems.length === 0) return false;
        if (key === "ArrowDown") setSelected((value) => (value + 1) % visibleItems.length);
        else if (key === "ArrowUp") setSelected((value) => (value - 1 + visibleItems.length) % visibleItems.length);
        else if (key === "Enter" || key === "Tab") return accept(activeIndex);
        else if (key === "Escape") setDismissedText(text);
        else return false;
        return true;
      },
    }));

    if (visibleItems.length === 0) return null;
    return (
      <div ref={list} id={listboxId} className="composer-suggestions" role="listbox" aria-label="输入建议">
        {visibleItems.map((item, index) => (
          <button
            id={composerSuggestionOptionId(listboxId, index)}
            type="button"
            role="option"
            aria-selected={activeIndex === index}
            data-state={activeIndex === index ? "active" : "idle"}
            key={item.id}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => accept(index)}
          >
            <TerminalSquare size={14} />
            <strong>{item.label}</strong>
            {item.detail ? <span>{item.detail}</span> : null}
          </button>
        ))}
      </div>
    );
  },
);
