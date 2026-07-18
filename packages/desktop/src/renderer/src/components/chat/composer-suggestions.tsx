import { useAui, useAuiState } from "@assistant-ui/react";
import { File, Folder, TerminalSquare } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { FileNode, SlashCommand } from "../../../../shared/contracts.ts";

export interface ComposerSuggestionsHandle {
  handleKey(key: string): boolean;
}

interface ComposerSuggestionsProps {
  projectId: string;
  commands: readonly SlashCommand[];
}

interface Suggestion {
  id: string;
  label: string;
  detail?: string;
  type: "command" | "file" | "directory";
  text: string;
}

/** 提供 Pi slash command 与 Project 文件的键盘补全。 */
export const ComposerSuggestions = forwardRef<ComposerSuggestionsHandle, ComposerSuggestionsProps>(
  function ComposerSuggestions({ projectId, commands }, ref) {
    const aui = useAui();
    const text = useAuiState((state) => state.composer.text);
    const context = completionContext(text);
    const [files, setFiles] = useState<FileNode[]>([]);
    const [selected, setSelected] = useState(0);
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

    const items = useMemo<Suggestion[]>(() => {
      if (!context) return [];
      if (context.type === "command") return commandSuggestions(commands, context.query);

      return files.map((file) => ({
        id: `${file.type}:${file.path}`,
        label: file.path,
        detail: file.type === "directory" ? "目录" : "文件",
        type: file.type,
        text: `@${file.path} `,
      }));
    }, [commands, context, files]);

    useEffect(() => setSelected(0), [context?.query, context?.type]);
    useEffect(() => scrollSelectedSuggestion(list.current), [items, selected]);

    const accept = (index: number) => {
      const item = items[index];
      if (!item || !context) return false;
      aui.composer().setText(`${text.slice(0, context.start)}${item.text}`);
      return true;
    };

    useImperativeHandle(ref, () => ({
      handleKey(key) {
        if (items.length === 0) return false;
        if (key === "ArrowDown") setSelected((value) => (value + 1) % items.length);
        else if (key === "ArrowUp") setSelected((value) => (value - 1 + items.length) % items.length);
        else if (key === "Enter" || key === "Tab") return accept(selected);
        else if (key === "Escape") setFiles([]);
        else return false;
        return true;
      },
    }));

    if (items.length === 0) return null;
    return (
      <div ref={list} className="composer-suggestions" role="listbox">
        {items.map((item, index) => (
          <button
            type="button"
            role="option"
            aria-selected={selected === index}
            className={selected === index ? "is-active" : ""}
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

export function scrollSelectedSuggestion(container: HTMLElement | null): void {
  container?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
}

export function commandSuggestions(commands: readonly SlashCommand[], query: string): Suggestion[] {
  const normalizedQuery = query.toLowerCase();
  return commands
    .filter(({ name }) => name.toLowerCase().includes(normalizedQuery))
    .map((command) => ({
      id: `${command.source}:${command.name}`,
      label: `/${command.name}`,
      detail: command.description,
      type: "command",
      text: `/${command.name} `,
    }));
}

function completionContext(text: string): { type: "command" | "file"; query: string; start: number } | null {
  if (/^\/[^\s]*$/.test(text)) return { type: "command", query: text.slice(1), start: 0 };
  const match = /(?:^|\s)@([^\s@]*)$/.exec(text);
  if (!match || match.index === undefined) return null;
  const at = text.lastIndexOf("@", match.index + match[0].length);
  return { type: "file", query: match[1] ?? "", start: at };
}
