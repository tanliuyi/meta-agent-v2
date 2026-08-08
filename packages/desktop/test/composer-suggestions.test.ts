import { describe, expect, it, vi } from "vitest";
import {
  commandSuggestions,
  composerCompletionContext,
  composerSuggestionOptionId,
  fileSuggestions,
  scrollSelectedSuggestion,
  searchSessions,
  searchSlashCommands,
  sessionMentionLabel,
  sessionPreview,
  slashCommandDisplayDescription,
  slashCommandDisplayName,
} from "../src/renderer/src/components/chat/composer/composer-suggestion-model.ts";
import type { SessionMentionCandidate, SlashCommand } from "../src/shared/contracts.ts";

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, right: left + width, bottom: top + height, width, height } as DOMRect;
}

function suggestionContainer(
  containerRect: DOMRect,
  itemRect: DOMRect,
  labelRect: DOMRect | null,
  scrollIntoView = vi.fn(),
): HTMLElement & { scrollTop: number } {
  return {
    scrollTop: 0,
    getBoundingClientRect: () => containerRect,
    querySelector: (selector: string) => {
      if (selector === '[aria-selected="true"], [data-highlighted]') {
        return { getBoundingClientRect: () => itemRect, scrollIntoView };
      }
      if (selector === ".composer-command-group-label, .composer-file-group-label") {
        return labelRect ? { getBoundingClientRect: () => labelRect } : null;
      }
      return null;
    },
  } as unknown as HTMLElement & { scrollTop: number };
}

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

  it("键盘选择变化时只滚动建议列表露出下方条目", () => {
    const scrollIntoView = vi.fn();
    const container = suggestionContainer(rect(0, 0, 300, 200), rect(0, 200, 300, 32), null, scrollIntoView);

    scrollSelectedSuggestion(container);

    expect(container.scrollTop).toBe(32);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("向上滚动时避开吸顶分组标签，避免高亮项被遮挡", () => {
    const container = suggestionContainer(rect(0, 0, 300, 200), rect(0, 20, 300, 32), rect(0, 0, 300, 36));
    container.scrollTop = 100;

    scrollSelectedSuggestion(container);

    // 条目顶部 20 位于标签（高 36）覆盖区：向上滚 16，对齐到标签之下。
    expect(container.scrollTop).toBe(84);
  });

  it("条目在视口上方时对齐到吸顶标签之下", () => {
    const container = suggestionContainer(rect(0, 0, 300, 200), rect(0, -40, 300, 32), rect(0, 0, 300, 36));
    container.scrollTop = 100;

    scrollSelectedSuggestion(container);

    // 条目顶部 -40 对齐到容器顶部 + 标签高 36：向上滚 76。
    expect(container.scrollTop).toBe(24);
  });

  it("条目完全可见时不滚动", () => {
    const scrollIntoView = vi.fn();
    const container = suggestionContainer(
      rect(0, 0, 300, 200),
      rect(0, 72, 300, 32),
      rect(0, 0, 300, 36),
      scrollIntoView,
    );
    container.scrollTop = 100;

    scrollSelectedSuggestion(container);

    expect(container.scrollTop).toBe(100);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("无分组标签的列表向上滚动时对齐容器顶部", () => {
    const container = suggestionContainer(rect(0, 0, 300, 200), rect(0, -40, 300, 32), null);
    container.scrollTop = 100;

    scrollSelectedSuggestion(container);

    expect(container.scrollTop).toBe(60);
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

  it("本地化 Desktop 内置命令和内置扩展命令，技能与提示词保持原样", () => {
    expect(slashCommandDisplayName({ name: "reload", source: "builtin" })).toBe("重新加载");
    expect(
      slashCommandDisplayDescription({
        name: "reload",
        description: "Reload extensions, skills, prompts, and context files",
        source: "builtin",
      }),
    ).toBe("重新加载扩展、技能、提示词和上下文文件");
    expect(slashCommandDisplayName({ name: "reload", source: "extension" })).toBe("reload");
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
    expect(commandSuggestions(commands, "技能 provider").map(({ label, text }) => ({ label, text }))).toEqual([
      { label: "add-llm-provider", text: ":skill[add-llm-provider]{name=skill:add-llm-provider} " },
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
        { name: "renderer", path: "src/renderer", type: "directory" },
        { name: "README.md", path: "README.md", type: "file" },
      ]),
    ).toMatchObject([
      { id: "src/main.ts", label: "main.ts", detail: "src", type: "file", text: ":file[src/main.ts] " },
      { id: "src/renderer", label: "renderer", detail: "src", type: "directory", text: ":directory[src/renderer] " },
      { id: "README.md", label: "README.md", detail: undefined, type: "file", text: ":file[README.md] " },
    ]);
  });

  it("会话按 title 检索：空查询保持 updatedAt 顺序，关键词匹配标题并优先生成 startsWith 结果", () => {
    const candidates: SessionMentionCandidate[] = [
      sessionCandidate("a", "修复登录模块的 bug", 300),
      sessionCandidate("b", "重构 API 网关", 200),
      sessionCandidate("c", "登录模块测试用例补充", 100),
    ];
    expect(searchSessions(candidates, "").map(({ id }) => id)).toEqual(["a", "b", "c"]);
    expect(searchSessions(candidates, "登录").map(({ id }) => id)).toEqual(["c", "a"]);
    expect(searchSessions(candidates, "重构").map(({ id }) => id)).toEqual(["b"]);
    expect(searchSessions(candidates, "不存在")).toEqual([]);
  });

  it("会话描述取 preview 首行，与标题重复或为空时不展示", () => {
    const candidate = sessionCandidate("a", "标题", 300);
    expect(sessionPreview({ ...candidate, preview: "第一行\n第二行" })).toBe("第一行");
    expect(sessionPreview({ ...candidate, preview: candidate.title })).toBeUndefined();
    expect(sessionPreview({ ...candidate, preview: "  \n  " })).toBeUndefined();
  });

  it("会话标题清洗移除破坏 directive 语法的字符", () => {
    expect(sessionMentionLabel("修复 [登录] 模块\n第二行")).toBe("修复 [登录  模块 第二行");
    expect(sessionMentionLabel("普通标题")).toBe("普通标题");
  });
});

function sessionCandidate(id: string, title: string, updatedAt: number): SessionMentionCandidate {
  return {
    id,
    projectId: "project",
    title,
    createdAt: 0,
    updatedAt,
    messageCount: 1,
    preview: title,
    archived: false,
    running: false,
    path: `/sessions/${id}.jsonl`,
  };
}
