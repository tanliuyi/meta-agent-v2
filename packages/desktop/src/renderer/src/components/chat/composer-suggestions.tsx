import { useAui, useAuiState } from "@assistant-ui/react";
import File from "lucide-react/dist/esm/icons/file.mjs";
import Folder from "lucide-react/dist/esm/icons/folder.mjs";
import TerminalSquare from "lucide-react/dist/esm/icons/square-terminal.mjs";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { FileNode, SlashCommand } from "../../../../shared/contracts.ts";
import {
  commandSuggestions,
  composerCompletionContext,
  composerSuggestionOptionId,
  fileSuggestions,
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
  projectId: string;
  commands: readonly SlashCommand[];
  onStateChange(state: ComposerSuggestionsState): void;
}

/** 提供 Pi slash command 与 Project 文件的键盘补全。 */
export const ComposerSuggestions = forwardRef<ComposerSuggestionsHandle, ComposerSuggestionsProps>(
  function ComposerSuggestions({ listboxId, projectId, commands, onStateChange }, ref) {
    const aui = useAui();
    const text = useAuiState((state) => state.composer.text);
    const context = useMemo(() => composerCompletionContext(text), [text]);
    const [files, setFiles] = useState<FileNode[]>([]);
    const [selected, setSelected] = useState(0);
    const [dismissedText, setDismissedText] = useState<string | null>(null);
    const list = useRef<HTMLDivElement>(null);

    useEffect(() => {
      if (context?.type !== "file") {
        setFiles((current) => (current.length === 0 ? current : []));
        return;
      }
      let active = true;
      const timeout = window.setTimeout(() => {
        void window.desktop.files
          .list(projectId, "", context.query)
          .then((items) => {
            if (active) setFiles(items.slice(0, 10));
          })
          .catch(() => {
            if (active) setFiles((current) => (current.length === 0 ? current : []));
          });
      }, 200);
      return () => {
        active = false;
        window.clearTimeout(timeout);
      };
    }, [context?.query, context?.type, projectId]);

    const items = useMemo(() => {
      if (!context) return [];
      return context.type === "command" ? commandSuggestions(commands, context.query) : fileSuggestions(files);
    }, [commands, context, files]);
    const visibleItems = dismissedText === text ? [] : items;
    const activeIndex = Math.min(selected, visibleItems.length - 1);
    const activeDescendant = activeIndex >= 0 ? composerSuggestionOptionId(listboxId, activeIndex) : undefined;

    useEffect(() => setSelected(0), [context?.query, context?.type]);
    useEffect(() => {
      if (dismissedText !== null && dismissedText !== text) setDismissedText(null);
    }, [dismissedText, text]);
    useEffect(() => scrollSelectedSuggestion(list.current), [activeIndex, visibleItems]);
    useEffect(() => {
      onStateChange({ expanded: visibleItems.length > 0, activeDescendant });
    }, [activeDescendant, onStateChange, visibleItems.length]);

    const accept = (index: number) => {
      const item = visibleItems[index];
      if (!item || !context) return false;
      aui.composer().setText(`${text.slice(0, context.start)}${item.text}`);
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
            {item.type === "command" ? (
              <TerminalSquare size={14} />
            ) : item.type === "directory" ? (
              <Folder size={14} />
            ) : (
              <File size={14} />
            )}
            <strong>{item.label}</strong>
            {item.detail ? <span>{item.detail}</span> : null}
          </button>
        ))}
      </div>
    );
  },
);
