import { describe, expect, it } from "vitest";
import {
  slashCommandAcceptsArguments,
  slashCommandText,
} from "../src/renderer/src/components/chat/composer/composer-command-trigger.tsx";
import type { SlashCommand } from "../src/shared/contracts.ts";

describe("slash command trigger", () => {
  it("uses latest RPC source metadata while preserving Desktop no-argument commands", () => {
    const commands: SlashCommand[] = [
      { name: "reload", source: "builtin", acceptsArguments: false },
      { name: "review", source: "extension" },
      { name: "template", source: "prompt" },
      { name: "skill:frontend", source: "skill" },
    ];

    expect(commands.map(slashCommandAcceptsArguments)).toEqual([false, true, true, false]);
  });

  it("combines the hidden command with trimmed argument text for Pi", () => {
    const command: SlashCommand = { name: "review", source: "extension" };

    expect(slashCommandText(command, "  inspect composer  ")).toBe("/review inspect composer");
    expect(slashCommandText(command, "   ")).toBe("/review");
  });
});
