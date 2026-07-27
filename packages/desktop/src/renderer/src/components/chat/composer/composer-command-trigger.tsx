import {
  ComposerPrimitive,
  type Unstable_DirectiveFormatter,
  type Unstable_DirectiveSegment,
  type Unstable_TriggerItem,
} from "@assistant-ui/react";
import Blocks from "lucide-react/dist/esm/icons/blocks.mjs";
import FileText from "lucide-react/dist/esm/icons/file-text.mjs";
import Sparkles from "lucide-react/dist/esm/icons/sparkles.mjs";
import TerminalSquare from "lucide-react/dist/esm/icons/square-terminal.mjs";
import { useMemo, useRef } from "react";
import type { SlashCommand } from "../../../../../shared/contracts.ts";
import { ComposerCommandScrollSync } from "./composer-command-scroll-sync.tsx";
import { searchSlashCommands, slashCommandDisplayName } from "./composer-suggestion-model.ts";
import { ComposerTriggerState } from "./composer-trigger-state.tsx";

const SLASH_COMMAND_RE = /(^|\s)\/([^\s/]+)/gu;

const COMMAND_GROUPS = [
  { source: "builtin", label: "内置命令", icon: TerminalSquare },
  { source: "extension", label: "扩展命令", icon: Blocks },
  { source: "prompt", label: "提示词", icon: FileText },
  { source: "skill", label: "技能", icon: Sparkles },
] as const satisfies readonly {
  source: SlashCommand["source"];
  label: string;
  icon: typeof TerminalSquare;
}[];

export function createSlashCommandFormatter(commands: readonly SlashCommand[]): Unstable_DirectiveFormatter {
  const commandNames = new Set(commands.map((command) => command.name));
  return {
    serialize(item) {
      return `/${item.id}`;
    },
    parse(text) {
      const segments: Unstable_DirectiveSegment[] = [];
      let lastIndex = 0;
      for (const match of text.matchAll(SLASH_COMMAND_RE)) {
        const name = match[2]!;
        if (!commandNames.has(name)) continue;

        const commandStart = (match.index ?? 0) + match[1]!.length;
        if (commandStart > lastIndex) segments.push({ kind: "text", text: text.slice(lastIndex, commandStart) });
        segments.push({ kind: "mention", type: "command", label: `/${name}`, id: name });
        lastIndex = commandStart + name.length + 1;
      }
      if (lastIndex < text.length) segments.push({ kind: "text", text: text.slice(lastIndex) });
      return segments.length === 0 ? [{ kind: "text", text }] : segments;
    },
  };
}

interface ComposerCommandTriggerProps {
  commands: readonly SlashCommand[];
  onOpenChange(open: boolean): void;
}

/** Official assistant-ui / trigger that preserves Pi's /command text protocol. */
export function ComposerCommandTrigger({ commands, onOpenChange }: ComposerCommandTriggerProps) {
  const list = useRef<HTMLDivElement>(null);
  const formatter = useMemo(() => createSlashCommandFormatter(commands), [commands]);
  const adapter = useMemo(
    () => ({
      categories: () => [],
      categoryItems: () => [],
      search: (query: string): readonly Unstable_TriggerItem[] => {
        return searchSlashCommands(commands, query).map((command) => ({
          id: command.name,
          type: command.source,
          label: slashCommandDisplayName(command),
          description: command.description,
        }));
      },
    }),
    [commands],
  );

  return (
    <ComposerPrimitive.Unstable_TriggerPopover
      ref={list}
      char="/"
      adapter={adapter}
      className="composer-suggestions"
      aria-label="命令建议"
    >
      <ComposerPrimitive.Unstable_TriggerPopover.Directive formatter={formatter} />
      <ComposerTriggerState onOpenChange={onOpenChange} />
      <ComposerCommandScrollSync container={list} />
      <ComposerPrimitive.Unstable_TriggerPopoverItems className="composer-suggestions-scroll">
        {(items) =>
          items.length > 0 ? (
            <div className="composer-command-groups">
              {COMMAND_GROUPS.map((group) => ({
                ...group,
                items: items.filter((item) => item.type === group.source),
              }))
                .filter((group) => group.items.length > 0)
                .sort((left, right) => items.indexOf(left.items[0]!) - items.indexOf(right.items[0]!))
                .map(({ source, label, icon: Icon, items: groupItems }) => (
                  <div key={source} className="composer-command-group" role="group" aria-label={label}>
                    <div className="composer-command-group-label" aria-hidden="true">
                      <Icon size={12} />
                      <span>{label}</span>
                      <span className="composer-command-group-count">{groupItems.length}</span>
                    </div>
                    {groupItems.map((item) => (
                      <ComposerPrimitive.Unstable_TriggerPopoverItem
                        key={item.id}
                        item={item}
                        className="composer-command-item"
                        data-command-source={source}
                      >
                        <Icon className="composer-command-item-icon" size={15} />
                        <strong title={item.label}>{item.label}</strong>
                        {item.description ? <span title={item.description}>{item.description}</span> : <span />}
                      </ComposerPrimitive.Unstable_TriggerPopoverItem>
                    ))}
                  </div>
                ))}
            </div>
          ) : (
            <div className="composer-suggestions-empty">无匹配命令</div>
          )
        }
      </ComposerPrimitive.Unstable_TriggerPopoverItems>
    </ComposerPrimitive.Unstable_TriggerPopover>
  );
}
