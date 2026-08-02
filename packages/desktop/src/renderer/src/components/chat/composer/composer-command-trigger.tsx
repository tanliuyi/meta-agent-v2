import { ComposerPrimitive, type Unstable_TriggerItem } from "@assistant-ui/react";
import Blocks from "lucide-react/dist/esm/icons/blocks.mjs";
import FileText from "lucide-react/dist/esm/icons/file-text.mjs";
import Sparkles from "lucide-react/dist/esm/icons/sparkles.mjs";
import TerminalSquare from "lucide-react/dist/esm/icons/square-terminal.mjs";
import { useMemo, useRef } from "react";
import type { SlashCommand } from "../../../../../shared/contracts.ts";
import { ComposerCommandScrollSync } from "./composer-command-scroll-sync.tsx";
import {
  searchSlashCommands,
  slashCommandDisplayDescription,
  slashCommandDisplayName,
} from "./composer-suggestion-model.ts";
import { ComposerTriggerState } from "./composer-trigger-state.tsx";

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

export function slashCommandAcceptsArguments(command: SlashCommand): boolean {
  return command.source !== "skill" && command.acceptsArguments !== false;
}

export function slashCommandText(command: SlashCommand, args: string): string {
  const trimmedArgs = args.trim();
  return `/${command.name}${trimmedArgs ? ` ${trimmedArgs}` : ""}`;
}

interface ComposerCommandTriggerProps {
  commands: readonly SlashCommand[];
  onSelect(command: SlashCommand): void;
  onOpenChange(open: boolean): void;
}

/** Slash command picker; selection is handled outside the editor so commands never become directive chips. */
export function ComposerCommandTrigger({ commands, onSelect, onOpenChange }: ComposerCommandTriggerProps) {
  const scrollContainer = useRef<HTMLDivElement>(null);
  const adapter = useMemo(
    () => ({
      categories: () => [],
      categoryItems: () => [],
      search: (query: string): readonly Unstable_TriggerItem[] => {
        return searchSlashCommands(commands, query).map((command) => ({
          id: command.name,
          type: command.source,
          label: slashCommandDisplayName(command),
          description: slashCommandDisplayDescription(command),
        }));
      },
    }),
    [commands],
  );

  return (
    <ComposerPrimitive.Unstable_TriggerPopover
      char="/"
      adapter={adapter}
      className="composer-suggestions"
      aria-label="命令建议"
    >
      <ComposerPrimitive.Unstable_TriggerPopover.Action
        removeOnExecute
        onExecute={(item) => {
          const command = commands.find(({ name }) => name === item.id);
          if (command) onSelect(command);
        }}
      />
      <ComposerTriggerState onOpenChange={onOpenChange} />
      <ComposerCommandScrollSync container={scrollContainer} />
      <ComposerPrimitive.Unstable_TriggerPopoverItems
        ref={scrollContainer}
        className="composer-suggestions-scroll composer-command-suggestions-scroll"
      >
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
                      {label}
                    </div>
                    {groupItems.map((item) => (
                      <ComposerPrimitive.Unstable_TriggerPopoverItem
                        key={item.id}
                        item={item}
                        className="composer-command-item"
                        data-command-source={source}
                      >
                        <Icon className="composer-command-item-icon" size={15} />
                        <strong>{item.label}</strong>
                        {item.description ? <span>{item.description}</span> : <span />}
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
