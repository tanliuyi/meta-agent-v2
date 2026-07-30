import { describe, expect, it, vi } from "vitest";
import {
  commandSuggestions,
  composerCompletionContext,
  composerSuggestionOptionId,
  fileSuggestions,
  scrollSelectedSuggestion,
  searchSlashCommands,
  slashCommandDisplayDescription,
  slashCommandDisplayName,
} from "../src/renderer/src/components/chat/composer/composer-suggestion-model.ts";
import type { SlashCommand } from "../src/shared/contracts.ts";

describe("ComposerSuggestions", () => {
  it("不截断排在十条之后的 extension 命令", () => {
    const commands: SlashCommand[] = Array.from({ length: 12 }, (_, index) => ({
      name: `command-${index + 1}`,
      source: "extension",
    }));

    const suggestions = commandSuggestions(commands, "");

    expect(suggestions).toHaveLength(12);
    expect(suggestions.at(-1)).toMatchObject({ label: "/command-12", text: "/command-12 " });
  });

  it("键盘选择变化时将活动项滚动到可视区域", () => {
    const scrollIntoView = vi.fn();
    const querySelector = vi.fn(() => ({ scrollIntoView }));
    const container = { querySelector } as unknown as HTMLElement;

    scrollSelectedSuggestion(container);

    expect(querySelector).toHaveBeenCalledWith('[aria-selected="true"], [data-highlighted]');
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
  });

  it("忽略大小写与分隔符并优先返回名称匹配", () => {
    const commands: SlashCommand[] = [
      { name: "provider-help", description: "Add an LLM integration", source: "extension" },
      { name: "skill:add-llm-provider", description: "Add a new LLM provider", source: "skill" },
      { name: "models", description: "Inspect the active provider", source: "builtin" },
    ];

    expect(searchSlashCommands(commands, "/ADD_LLM").map(({ name }) => name)).toEqual([
      "skill:add-llm-provider",
      "provider-help",
    ]);
    expect(searchSlashCommands(commands, "provider").map(({ name }) => name)).toEqual([
      "provider-help",
      "skill:add-llm-provider",
      "models",
    ]);
  });

  it("仅本地化内置扩展命令，技能与提示词保持原样", () => {
    expect(slashCommandDisplayName({ name: "reload", source: "builtin" })).toBe("reload");
    expect(slashCommandDisplayName({ name: "skill:add-llm-provider", source: "skill" })).toBe("add-llm-provider");
    expect(slashCommandDisplayName({ name: "memory-interview", source: "extension" })).toBe("记忆访谈");
    expect(slashCommandDisplayName({ name: "subagents", source: "extension" })).toBe("subagents");
    expect(slashCommandDisplayName({ name: "run", source: "extension" })).toBe("run");
    expect(slashCommandDisplayName({ name: "subagents-watchdog", source: "extension" })).toBe("subagents-watchdog");
    expect(
      slashCommandDisplayDescription({
        name: "parallel-review",
        description: "Parallel subagents review",
        source: "prompt",
      }),
    ).toBe("Parallel subagents review");
  });

  it("支持多关键词、来源名称和说明检索", () => {
    const commands: SlashCommand[] = [
      { name: "memory-consolidate", description: "Manually trigger memory cleanup", source: "extension" },
      { name: "skill:add-llm-provider", description: "Checklist for adding a provider", source: "skill" },
      { name: "parallel", source: "extension" },
    ];

    expect(commandSuggestions(commands, "trigger cleanup").map(({ label }) => label)).toEqual(["/整理记忆"]);
    expect(commandSuggestions(commands, "技能 provider").map(({ label }) => label)).toEqual([
      "/skill:add-llm-provider",
    ]);
  });

  it("使用中文名称和描述检索与展示，但插入原始命令", () => {
    const commands: SlashCommand[] = [
      {
        name: "memory-interview",
        description: "Answer questions to pre-fill your user profile",
        source: "extension",
      },
    ];

    expect(commandSuggestions(commands, "用户资料")).toEqual([
      {
        id: "extension:memory-interview",
        label: "/记忆访谈",
        detail: "回答问题并预先填写用户资料，以便跨会话记住你",
        type: "command",
        text: "/memory-interview ",
      },
    ]);
    expect(searchSlashCommands(commands, "memory interview")).toEqual(commands);
  });

  it("保留适合对话场景的 Hermes Memory 命令", () => {
    const commands: SlashCommand[] = ["memory-interview", "memory-consolidate", "learn-memory-tool"].map((name) => ({
      name,
      source: "extension",
    }));

    expect(commandSuggestions(commands, "").map(({ label }) => label)).toEqual([
      "/记忆访谈",
      "/整理记忆",
      "/了解记忆工具",
    ]);
    expect(
      searchSlashCommands(commands, "记忆")
        .map(({ name }) => name)
        .sort(),
    ).toEqual(["memory-interview", "memory-consolidate", "learn-memory-tool"].sort());
  });

  it("为 combobox 解析补全上下文并生成稳定 option id", () => {
    expect(composerCompletionContext("/memory")).toEqual({ type: "command", query: "memory", start: 0 });
    expect(composerCompletionContext("查看 @src/main")).toEqual({ type: "file", query: "src/main", start: 3 });
    expect(composerSuggestionOptionId("composer-list", 2)).toBe("composer-list-option-2");
  });

  it("将文件名与父路径分层展示，并序列化原始路径", () => {
    expect(
      fileSuggestions([
        { name: "main.ts", path: "src/main.ts", type: "file" },
        { name: "README.md", path: "README.md", type: "file" },
      ]),
    ).toMatchObject([
      { id: "src/main.ts", label: "main.ts", detail: "src", text: ":file[src/main.ts] " },
      { id: "README.md", label: "README.md", detail: undefined, text: ":file[README.md] " },
    ]);
  });
});
