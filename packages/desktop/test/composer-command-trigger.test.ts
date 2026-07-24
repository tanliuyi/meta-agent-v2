import { describe, expect, it } from "vitest";
import { createSlashCommandFormatter } from "../src/renderer/src/components/chat/composer-command-trigger.tsx";
import type { SlashCommand } from "../src/shared/contracts.ts";

const COMMANDS: readonly SlashCommand[] = [
  { name: "help", description: "Show help", source: "builtin" },
  { name: "skill:review", description: "Review changes", source: "skill" },
];

describe("slash command formatter", () => {
  const formatter = createSlashCommandFormatter(COMMANDS);

  it("parses registered commands at text boundaries", () => {
    expect(formatter.parse("Run /help then /skill:review")).toEqual([
      { kind: "text", text: "Run " },
      { kind: "mention", type: "command", label: "/help", id: "help" },
      { kind: "text", text: " then " },
      { kind: "mention", type: "command", label: "/skill:review", id: "skill:review" },
    ]);
  });

  it("leaves URLs and file paths as plain text", () => {
    const text = "See https://example.com/a, src/main.ts, /usr/bin, and /unknown.";
    expect(formatter.parse(text)).toEqual([{ kind: "text", text }]);
  });
});
