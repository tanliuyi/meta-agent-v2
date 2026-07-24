import {
  ComposerPrimitive,
  type Unstable_DirectiveFormatter,
  type Unstable_DirectiveSegment,
  type Unstable_TriggerItem,
} from "@assistant-ui/react";
import TerminalSquare from "lucide-react/dist/esm/icons/square-terminal.mjs";
import { useMemo } from "react";
import type { SlashCommand } from "../../../../shared/contracts.ts";
import { ComposerTriggerState } from "./composer-trigger-state.tsx";

const SLASH_COMMAND_RE = /(^|\s)\/([^\s/]+)/gu;

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
  const formatter = useMemo(() => createSlashCommandFormatter(commands), [commands]);
  const adapter = useMemo(
    () => ({
      categories: () => [],
      categoryItems: () => [],
      search: (query: string): readonly Unstable_TriggerItem[] => {
        const normalizedQuery = query.toLowerCase();
        return commands
          .filter((command) => command.name.toLowerCase().includes(normalizedQuery))
          .map((command) => ({
            id: command.name,
            type: "command",
            label: `/${command.name}`,
            description: command.description,
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
      <ComposerPrimitive.Unstable_TriggerPopover.Directive formatter={formatter} />
      <ComposerTriggerState onOpenChange={onOpenChange} />
      <ComposerPrimitive.Unstable_TriggerPopoverItems>
        {(items) =>
          items.map((item) => (
            <ComposerPrimitive.Unstable_TriggerPopoverItem key={item.id} item={item}>
              <TerminalSquare size={14} />
              <strong>{item.label}</strong>
              {item.description ? <span>{item.description}</span> : null}
            </ComposerPrimitive.Unstable_TriggerPopoverItem>
          ))
        }
      </ComposerPrimitive.Unstable_TriggerPopoverItems>
    </ComposerPrimitive.Unstable_TriggerPopover>
  );
}
