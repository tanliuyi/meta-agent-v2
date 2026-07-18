import type { ResourceLoader } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { getDraftCommands, getSessionCommands } from "../src/main/pi/session-commands.ts";

describe("session commands", () => {
  it("只从 Pi public resources 合并 extension、prompt 和 skill 命令", () => {
    const commands = getSessionCommands({
      extensionRunner: {
        getRegisteredCommands: () => [{ invocationName: "review", description: "审查代码" }],
      },
      promptTemplates: [{ name: "fix", description: "修复问题" }],
      resourceLoader: {
        getSkills: () => ({ skills: [{ name: "frontend", description: "前端设计" }] }),
      },
    });

    expect(commands).toEqual([
      { name: "review", description: "审查代码", source: "extension" },
      { name: "fix", description: "修复问题", source: "prompt" },
      { name: "skill:frontend", description: "前端设计", source: "skill" },
    ]);
    expect(commands.some(({ source }) => source === "builtin")).toBe(false);
  });

  it("从 draft resources 暴露全局 extension 命令并保留重复命令后缀", () => {
    const command = (name: string, description: string) => ({ name, description });
    const resourceLoader = {
      getExtensions: () => ({
        extensions: [
          { commands: new Map([["memory", command("memory", "Memory command")]]) },
          { commands: new Map([["memory", command("memory", "Other memory command")]]) },
        ],
      }),
      getPrompts: () => ({ prompts: [{ name: "fix", description: "Fix prompt" }] }),
      getSkills: () => ({ skills: [{ name: "review", description: "Review skill" }] }),
    } as unknown as ResourceLoader;

    expect(getDraftCommands(resourceLoader)).toEqual([
      { name: "memory:1", description: "Memory command", source: "extension" },
      { name: "memory:2", description: "Other memory command", source: "extension" },
      { name: "fix", description: "Fix prompt", source: "prompt" },
      { name: "skill:review", description: "Review skill", source: "skill" },
    ]);
  });
});
