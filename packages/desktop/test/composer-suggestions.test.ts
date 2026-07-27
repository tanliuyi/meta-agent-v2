import { describe, expect, it, vi } from "vitest";
import {
  commandSuggestions,
  composerCompletionContext,
  composerSuggestionOptionId,
  fileSuggestions,
  scrollSelectedSuggestion,
  searchSlashCommands,
  slashCommandDisplayName,
} from "../src/renderer/src/components/chat/composer/composer-suggestion-model.ts";
import type { SlashCommand } from "../src/shared/contracts.ts";

describe("ComposerSuggestions", () => {
  it("不截断排在十条之后的 extension 命令", () => {
    const commands: SlashCommand[] = Array.from({ length: 12 }, (_, index) => ({
      name: index === 11 ? "memory-insights" : `command-${index + 1}`,
      source: "extension",
    }));

    const suggestions = commandSuggestions(commands, "");

    expect(suggestions).toHaveLength(12);
    expect(suggestions.at(-1)).toMatchObject({ label: "/memory-insights", text: "/memory-insights " });
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

  it("仅在 UI 展示名称中移除命令协议前缀", () => {
    expect(slashCommandDisplayName({ name: "reload", source: "builtin" })).toBe("reload");
    expect(slashCommandDisplayName({ name: "skill:add-llm-provider", source: "skill" })).toBe("add-llm-provider");
  });

  it("支持多关键词、来源名称和说明检索", () => {
    const commands: SlashCommand[] = [
      { name: "memory-insights", description: "List managed and loaded procedural skills", source: "extension" },
      { name: "skill:add-llm-provider", description: "Checklist for adding a provider", source: "skill" },
      { name: "parallel", source: "extension" },
    ];

    expect(commandSuggestions(commands, "managed skills").map(({ label }) => label)).toEqual(["/memory-insights"]);
    expect(commandSuggestions(commands, "技能 provider").map(({ label }) => label)).toEqual([
      "/skill:add-llm-provider",
    ]);
  });

  it("为 combobox 解析补全上下文并生成稳定 option id", () => {
    expect(composerCompletionContext("/memory")).toEqual({ type: "command", query: "memory", start: 0 });
    expect(composerCompletionContext("查看 @src/main")).toEqual({ type: "file", query: "src/main", start: 3 });
    expect(composerSuggestionOptionId("composer-list", 2)).toBe("composer-list-option-2");
  });

  it("将选中的文件序列化为 assistant-ui directive", () => {
    expect(fileSuggestions([{ name: "main.ts", path: "src/main.ts", type: "file" }])).toMatchObject([
      { text: ":file[src/main.ts] " },
    ]);
  });
});
