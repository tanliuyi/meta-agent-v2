import { describe, expect, it } from "vitest";
import {
  slashCommandAcceptsArguments,
  slashCommandText,
} from "../src/renderer/src/components/chat/composer/composer-command-trigger.tsx";
import type { SlashCommand } from "../src/shared/contracts.ts";

describe("slash command trigger", () => {
  it("only shows the argument command marker for non-skill commands that accept arguments", () => {
    const commands: SlashCommand[] = [
      { name: "reload", source: "builtin", acceptsArguments: false },
      { name: "review", source: "extension", acceptsArguments: true },
      { name: "legacy", source: "extension" },
      { name: "skill:frontend", source: "skill", acceptsArguments: true },
    ];

    expect(commands.map(slashCommandAcceptsArguments)).toEqual([false, true, true, false]);
  });

  it("combines the hidden command with trimmed argument text for Pi", () => {
    const command: SlashCommand = { name: "review", source: "extension", acceptsArguments: true };

    expect(slashCommandText(command, "  inspect composer  ")).toBe("/review inspect composer");
    expect(slashCommandText(command, "   ")).toBe("/review");
  });
});
