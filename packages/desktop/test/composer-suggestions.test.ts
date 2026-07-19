import { describe, expect, it, vi } from "vitest";
import {
  commandSuggestions,
  composerCompletionContext,
  composerSuggestionOptionId,
  scrollSelectedSuggestion,
} from "../src/renderer/src/components/chat/composer-suggestion-model.ts";
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

    expect(querySelector).toHaveBeenCalledWith('[aria-selected="true"]');
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
  });

  it("输入命令前缀时仍按名称过滤", () => {
    const commands: SlashCommand[] = [
      { name: "memory-insights", source: "extension" },
      { name: "parallel", source: "extension" },
    ];

    expect(commandSuggestions(commands, "MEMORY").map(({ label }) => label)).toEqual(["/memory-insights"]);
  });

  it("为 combobox 解析补全上下文并生成稳定 option id", () => {
    expect(composerCompletionContext("/memory")).toEqual({ type: "command", query: "memory", start: 0 });
    expect(composerCompletionContext("查看 @src/main")).toEqual({ type: "file", query: "src/main", start: 3 });
    expect(composerSuggestionOptionId("composer-list", 2)).toBe("composer-list-option-2");
  });
});
