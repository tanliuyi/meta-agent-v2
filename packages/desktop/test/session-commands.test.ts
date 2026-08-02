import type { ResourceLoader } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { getDraftCommands, getSessionCommands } from "../src/main/pi/session-commands.ts";

describe("session commands", () => {
  it("合并 Desktop 支持的 builtin 与 Pi public resource 命令", () => {
    const commands = getSessionCommands({
      extensionRunner: {
        getRegisteredCommands: () => [{ invocationName: "review", description: "审查代码", acceptsArguments: false }],
      },
      promptTemplates: [{ name: "fix", description: "修复问题" }],
      resourceLoader: {
        getSkills: () => ({ skills: [{ name: "frontend", description: "前端设计" }] }),
      },
    });

    expect(commands).toEqual([
      {
        name: "reload",
        description: "Reload extensions, skills, prompts, and context files",
        source: "builtin",
        acceptsArguments: false,
      },
      { name: "review", description: "审查代码", source: "extension", acceptsArguments: false },
      { name: "fix", description: "修复问题", source: "prompt", acceptsArguments: true },
      { name: "skill:frontend", description: "前端设计", source: "skill", acceptsArguments: true },
    ]);
    expect(commands.filter(({ source }) => source === "builtin")).toHaveLength(1);
  });

  it("在 Composer 中隐藏 Desktop 内置 subagents 命令且保留用户同名命令", () => {
    const commands = getSessionCommands({
      extensionRunner: {
        getRegisteredCommands: () => [
          {
            invocationName: "run:1",
            description: "Run a built-in subagent",
            sourceInfo: { path: "<inline:desktop:pi-subagents>" },
          },
          {
            invocationName: "run:2",
            description: "Run a user workflow",
            sourceInfo: { path: "/user/extensions/workflow.ts" },
          },
        ],
      },
      promptTemplates: [],
      resourceLoader: { getSkills: () => ({ skills: [] }) },
    });

    expect(commands).toEqual([
      {
        name: "reload",
        description: "Reload extensions, skills, prompts, and context files",
        source: "builtin",
        acceptsArguments: false,
      },
      { name: "run:2", description: "Run a user workflow", source: "extension", acceptsArguments: true },
    ]);
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
      { name: "memory:1", description: "Memory command", source: "extension", acceptsArguments: true },
      { name: "memory:2", description: "Other memory command", source: "extension", acceptsArguments: true },
      { name: "fix", description: "Fix prompt", source: "prompt", acceptsArguments: true },
      { name: "skill:review", description: "Review skill", source: "skill", acceptsArguments: true },
    ]);
  });

  it("draft Composer 隐藏 Desktop 内置 subagents 命令且保留运行时后缀", () => {
    const command = (description: string, path: string) => ({
      name: "run",
      description,
      sourceInfo: { path },
    });
    const resourceLoader = {
      getExtensions: () => ({
        extensions: [
          {
            commands: new Map([["run", command("Run a built-in subagent", "<inline:desktop:pi-subagents>")]]),
          },
          {
            commands: new Map([["run", command("Run a user workflow", "/user/extensions/workflow.ts")]]),
          },
        ],
      }),
      getPrompts: () => ({ prompts: [] }),
      getSkills: () => ({ skills: [] }),
    } as unknown as ResourceLoader;

    expect(getDraftCommands(resourceLoader)).toEqual([
      { name: "run:2", description: "Run a user workflow", source: "extension", acceptsArguments: true },
    ]);
  });
});
