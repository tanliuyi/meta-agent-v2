import { readFileSync } from "node:fs";
import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { TooltipProvider } from "@renderer/shared/ui/tooltip-provider";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/renderer/src/state/desktop-context.tsx", () => ({
  useDesktopSelector: (
    selector: (state: { activeProjectId: string; projects: Array<{ id: string; cwd: string }> }) => unknown,
  ) => selector({ activeProjectId: "project", projects: [{ id: "project", cwd: "/Users/test/project" }] }),
}));

vi.mock("../src/renderer/src/components/chat/tool-file-target.tsx", () => ({
  ToolFileTarget: ({ path }: { path: string }) => (
    <button type="button" className="tool-target tool-file-target">
      {path}
    </button>
  ),
}));

import { ToolView } from "../src/renderer/src/components/chat/tool-view.tsx";
import { ToolContent } from "../src/renderer/src/components/chat/tools/tool-content.tsx";
import {
  diffToolEdit,
  parseRenderedToolDiff,
  parseToolResult,
  projectDisplayToolPath,
} from "../src/renderer/src/components/chat/tools/tool-format.ts";

const chatCss = readFileSync(new URL("../src/renderer/src/styles/chat.css", import.meta.url), "utf8");

describe("ToolView TUI parity", () => {
  it("用 TUI 标题与 pending 底色展示流式 write 参数", () => {
    const markup = renderToolView(
      toolCall({
        toolName: "write",
        args: { path: "src/main.ts", content: "const value = 1;" },
        status: { type: "running" },
        artifact: { execution: "streaming-args" },
      }),
    );

    expect(markup).toContain('data-tool-name="write"');
    expect(markup).toContain('data-tool-status="running"');
    expect(markup).not.toContain("const value = 1;");
    expect(markup.match(/aria-expanded="false"/g)).toHaveLength(2);
    expect(markup).toContain('data-state="closed"');
  });

  it("bash content 默认完全折叠，标题只展示 description", () => {
    const partialResult = toolResult(Array.from({ length: 7 }, (_, index) => `line-${index + 1}`).join("\n"));
    const markup = renderToolView(
      toolCall({
        toolName: "bash",
        args: { command: "generate output", description: "生成测试输出" },
        status: { type: "running" },
        artifact: { execution: "running", partialResult },
      }),
    );

    expect(markup).toContain("生成测试输出");
    expect(markup).not.toContain("generate output");
    expect(markup).toContain("tool-running-cursor");
    expect(markup).not.toContain("tool-running-cursor-end");
    expect(markup).not.toContain("data-cursor-position");
    expect(markup).not.toContain("line-1");
  });

  it("展开后的 bash content 展示两行截断命令并随 delta 原位更新", () => {
    const command = "printf one\nprintf two\nprintf three";
    const renderDelta = (result: unknown) =>
      renderToStaticMarkup(
        <ToolContent name="bash" args={{ command }} result={result} error={false} expanded argsComplete />,
      );
    const first = renderDelta(toolResult("one\ntwo"));
    const next = renderDelta(toolResult("one\ntwo\nthree\nfour\nfive\nsix"));

    expect(first).toContain('class="tool-command"');
    expect(first).toContain("printf one\nprintf two\nprintf three");
    expect(chatCss).toMatch(/\.tool-command\s*\{[^}]*-webkit-line-clamp:\s*2;/s);
    expect(first).toContain("one\ntwo");
    expect(first).not.toContain("six");
    expect(next).toContain("one\ntwo\nthree\nfour\nfive\nsix");
  });

  it("write 成功后隐藏重复的协议结果", () => {
    const markup = renderToStaticMarkup(
      <ToolContent
        name="write"
        args={{ path: "src/main.ts", content: "const value = 1;" }}
        result={toolResult("Successfully wrote 16 bytes to src/main.ts")}
        error={false}
        expanded
        argsComplete
      />,
    );

    expect(markup).toContain("const value = 1;");
    expect(markup).not.toContain("Successfully wrote");
    expect(markup).not.toContain("&quot;content&quot;");
  });

  it("read 成功结果默认隐藏，展开后显示解包文本", () => {
    const collapsed = renderToStaticMarkup(
      <ToolContent
        name="read"
        args={{ path: "notes.txt" }}
        result={toolResult("line one\nline two")}
        error={false}
        expanded={false}
        argsComplete
      />,
    );
    const expanded = renderToStaticMarkup(
      <ToolContent
        name="read"
        args={{ path: "notes.txt" }}
        result={toolResult("line one\nline two")}
        error={false}
        expanded
        argsComplete
      />,
    );

    expect(collapsed).toBe("");
    expect(expanded).toContain("line one\nline two");
  });

  it("edit 参数 delta 完成前不展示半成品 diff", () => {
    const markup = renderToStaticMarkup(
      <ToolContent
        name="edit"
        args={{ path: "src/main.ts", edits: [{ oldText: "before", newText: "after" }] }}
        result={undefined}
        error={false}
        expanded={false}
        argsComplete={false}
      />,
    );

    expect(markup).toBe("");
  });

  it("优先展示 TUI details.diff 的文件行号并隐藏成功文案", () => {
    const result = toolResult("Successfully replaced 1 block(s)", {
      diff: " 9 keep\n-10 before\n+10 after\n 11 keep",
    });
    const markup = renderToStaticMarkup(
      <ToolContent
        name="edit"
        args={{ path: "src/main.ts", edits: [{ oldText: "before", newText: "after" }] }}
        result={result}
        error={false}
        expanded
        argsComplete
      />,
    );

    expect(markup).toContain(">before</span>");
    expect(markup).toContain(">after</span>");
    expect(markup).not.toContain("Successfully replaced");
  });

  it("edit diff 始终完整渲染，不做二级裁剪", () => {
    const diff = [
      ...Array.from({ length: 14 }, (_, index) => ` ${index + 1} context-${index + 1}`),
      "-15 before",
      "+15 after",
      ...Array.from({ length: 15 }, (_, index) => ` ${index + 16} context-${index + 16}`),
    ].join("\n");
    const markup = renderToStaticMarkup(
      <ToolContent
        name="edit"
        args={{ path: "src/main.ts" }}
        result={toolResult("done", { diff })}
        error={false}
        expanded={false}
        argsComplete
      />,
    );

    expect(markup).toContain(">context-1</span>");
    expect(markup).toContain(">before</span>");
    expect(markup).toContain(">after</span>");
    expect(markup).toContain(">context-30</span>");
  });

  it("edit 失败时只展示真实错误，不展示参数级伪 diff", () => {
    const markup = renderToStaticMarkup(
      <ToolContent
        name="edit"
        args={{ path: "src/main.ts", edits: [{ oldText: "before", newText: "after" }] }}
        result={toolResult("Could not find the exact text")}
        error
        expanded
        argsComplete
      />,
    );

    expect(markup).toContain("Could not find the exact text");
    expect(markup).not.toContain(">before</span>");
  });

  it("失败结果使用 destructive tone 并保留具体错误", () => {
    const markup = renderToStaticMarkup(
      <ToolContent
        name="read"
        args={{ path: "missing.ts" }}
        result={toolResult("File not found")}
        error
        expanded
        argsComplete
      />,
    );

    expect(markup).toContain('data-tone="destructive"');
    expect(markup).toContain("File not found");
  });

  it("标题与尾部均可折叠，文件按钮保持同级", () => {
    const markup = renderToolView(toolCall({ toolName: "read", args: { path: "src/read.ts" } }));

    expect(markup.match(/aria-expanded=/g)).toHaveLength(2);
    expect(markup).toContain(">src/read.ts</button>");
  });

  it.each(["read", "write", "edit"])("%s 标题展示项目相对路径", (toolName) => {
    const absolutePath = "/Users/test/project/packages/desktop/src/renderer/src/components/chat/tool-view.tsx";
    const markup = renderToolView(toolCall({ toolName, args: { path: absolutePath } }));

    expect(markup).toContain(">packages/desktop/src/renderer/src/components/chat/tool-view.tsx</button>");
    expect(markup).not.toContain(absolutePath);
  });

  it("项目外文件标题保留完整绝对路径", () => {
    const absolutePath = "/Users/test/other/read.ts";
    const markup = renderToolView(toolCall({ toolName: "read", args: { path: absolutePath } }));

    expect(markup).toContain(`>${absolutePath}</button>`);
  });

  it("ls、find 与 grep 使用项目相对路径", () => {
    const lsMarkup = renderToolView(
      toolCall({ toolName: "ls", args: { path: "/Users/test/project/packages/desktop" } }),
    );
    const findMarkup = renderToolView(
      toolCall({ toolName: "find", args: { pattern: "*.tsx", path: "/Users/test/project/packages/desktop" } }),
    );
    const grepMarkup = renderToolView(
      toolCall({ toolName: "grep", args: { pattern: "ToolView", path: "/Users/test/project/packages/desktop" } }),
    );

    expect(lsMarkup).toContain(">packages/desktop</span>");
    expect(findMarkup).toContain("in packages/desktop");
    expect(grepMarkup).toContain("in packages/desktop");
    expect(`${lsMarkup}${findMarkup}${grepMarkup}`).not.toContain("/Users/test/project");
  });

  it("展示 read 行范围与 grep 查询上下文", () => {
    const readMarkup = renderToolView(
      toolCall({ toolName: "read", args: { path: "src/read.ts", offset: 120, limit: 20 } }),
    );
    const grepMarkup = renderToolView(
      toolCall({ toolName: "grep", args: { pattern: "ToolView", path: "src", glob: "*.tsx" } }),
    );

    expect(readMarkup).toContain(":120-139");
    expect(grepMarkup).toContain("/ToolView/");
    expect(grepMarkup).toContain("in src (*.tsx)");
  });
});

describe("subagent 工具详情", () => {
  it("single 模式标题展示 agent 与任务摘要", () => {
    const markup = renderToolView(
      toolCall({
        toolName: "subagent",
        args: { agent: "researcher", task: "调研竞品\n输出报告" },
      }),
    );

    expect(markup).toContain(">researcher</span>");
    expect(markup).toContain("调研竞品");
    expect(markup).not.toContain("输出报告");
    expect(markup).not.toContain("&quot;");
  });

  it("预检失败在标题中明确标记为调用失败", () => {
    const markup = renderToolView(
      toolCall({
        toolName: "subagent",
        args: { agent: "reviewer", task: "检查改动", acceptance: "reviewed" },
        result: toolResult("acceptance cannot be requested explicitly", { mode: "single", results: [] }),
        isError: true,
      }),
    );

    expect(markup).toContain('data-tool-status="error"');
    expect(markup).toContain('class="tool-error-label"');
    expect(markup).toContain("调用失败");
  });

  it("parallel 模式标题按 count 展开任务数", () => {
    const markup = renderToolView(
      toolCall({
        toolName: "subagent",
        args: {
          tasks: [
            { agent: "researcher", task: "a", count: 2 },
            { agent: "writer", task: "b" },
          ],
        },
      }),
    );

    expect(markup).toContain("parallel ×3");
    expect(markup).toContain("researcher, writer");
  });

  it("chain 模式标题展示步骤数与 agent 顺序", () => {
    const markup = renderToolView(
      toolCall({
        toolName: "subagent",
        args: {
          chain: [
            { agent: "scout", task: "a" },
            { agent: "planner", task: "b" },
          ],
        },
      }),
    );

    expect(markup).toContain("chain ×2");
    expect(markup).toContain("scout → planner");
  });

  it.each([
    ["缺少 details", toolResult("兼容模式最终输出")],
    ["只有空 results", toolResult("兼容模式最终输出", { mode: "single", results: [] })],
  ])("成功结果%s时回退展示普通文本", (_scenario, result) => {
    const markup = renderToStaticMarkup(
      <ToolContent
        name="subagent"
        args={{ agent: "legacy-agent", task: "兼容调用" }}
        result={result}
        error={false}
        expanded
        argsComplete
      />,
    );

    expect(markup).toContain("兼容模式最终输出");
  });

  it("运行中的 partial details 渲染逐 agent 进度行", () => {
    const markup = renderToStaticMarkup(
      <ToolContent
        name="subagent"
        args={{ agent: "researcher", task: "调研" }}
        result={toolResult("progress", {
          mode: "single",
          results: [],
          progress: [
            {
              index: 0,
              agent: "researcher",
              status: "running",
              task: "调研",
              currentTool: "grep",
              currentToolArgs: "pattern",
              recentTools: [],
              recentOutput: [],
              toolCount: 4,
              tokens: 1234,
              durationMs: 65_000,
            },
          ],
        })}
        error={false}
        expanded
        argsComplete
      />,
    );

    expect(markup).toContain("运行中");
    expect(markup).toContain("grep pattern");
    expect(markup).toContain("4 次工具");
    expect(markup).toContain("1.2k tok");
    expect(markup).toContain("1m5s");
    expect(markup).not.toContain("&quot;status&quot;");
  });

  it("运行中的 result 展示 provider/model 并忽略字面量 undefined", () => {
    const markup = renderToStaticMarkup(
      <ToolContent
        name="subagent"
        args={{ agent: "reviewer", task: "检查改动" }}
        result={toolResult("progress", {
          mode: "single",
          results: [
            {
              agent: "reviewer",
              task: "检查改动",
              exitCode: 0,
              provider: "meta-agent",
              model: "gpt-5.6-sol",
              usage: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
              progress: {
                index: 0,
                agent: "reviewer",
                status: "running",
                task: "检查改动",
                currentTool: "undefined",
                currentToolArgs: "undefined",
                error: "undefined",
                recentTools: [],
                recentOutput: [],
                toolCount: 1,
                tokens: 1200,
                durationMs: 7000,
              },
            },
          ],
          progress: [
            {
              index: 0,
              agent: "reviewer",
              status: "running",
              task: "检查改动",
              currentTool: "undefined",
              currentToolArgs: "undefined",
              error: "undefined",
              recentTools: [],
              recentOutput: [],
              toolCount: 1,
              tokens: 1200,
              durationMs: 7000,
            },
          ],
        })}
        error={false}
        expanded
        argsComplete
      />,
    );

    expect(markup).toContain("meta-agent/gpt-5.6-sol");
    expect(markup).toContain("运行中");
    expect(markup).not.toContain("undefined");
  });

  it("完成后的 details 渲染结果状态、输出与汇总，不落 JSON", () => {
    const markup = renderToStaticMarkup(
      <ToolContent
        name="subagent"
        args={{
          tasks: [
            { agent: "researcher", task: "调研" },
            { agent: "writer", task: "撰写" },
          ],
        }}
        result={toolResult("done", {
          mode: "parallel",
          results: [
            {
              agent: "researcher",
              task: "调研",
              exitCode: 0,
              usage: { input: 1000, output: 2000, cacheRead: 0, cacheWrite: 0, cost: 0.12, turns: 5 },
              model: "claude-sonnet-5",
              finalOutput: "调研结论第一行",
            },
            {
              agent: "writer",
              task: "撰写",
              exitCode: 1,
              error: "工具超出预算",
              usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
            },
          ],
          totalChildUsage: { input: 1010, output: 2020, cacheRead: 0, cacheWrite: 0, cost: 0.12, turns: 6 },
          totalCost: { inputTokens: 1010, outputTokens: 2020, costUsd: 0.12 },
        })}
        error={false}
        expanded
        argsComplete
      />,
    );

    expect(markup).toContain("完成");
    expect(markup).toContain("claude-sonnet-5");
    expect(markup).toContain("调研结论第一行");
    expect(markup).toContain("失败");
    expect(markup).toContain("工具超出预算");
    expect(markup).toContain("共 2 个子任务");
    expect(markup).toContain("$0.12");
    expect(markup).not.toContain("&quot;exitCode&quot;");
  });

  it("完成输出按 Markdown 渲染", () => {
    const markup = renderToStaticMarkup(
      <ToolContent
        name="subagent"
        args={{ agent: "writer", task: "撰写结论" }}
        result={toolResult("done", {
          mode: "single",
          results: [
            {
              agent: "writer",
              exitCode: 0,
              finalOutput: "**结论**\n\n- 第一项\n- 第二项",
            },
          ],
        })}
        error={false}
        expanded
        argsComplete
      />,
    );

    expect(markup).toContain('data-streamdown="strong"');
    expect(markup).toContain('data-streamdown="unordered-list"');
    expect(markup).toContain('data-streamdown="list-item"');
    expect(markup).not.toContain('<pre class="tool-result"');
  });

  it("subagent_wait 展示等待说明并复用结果行", () => {
    const markup = renderToStaticMarkup(
      <ToolContent
        name="subagent_wait"
        args={{ all: true }}
        result={toolResult("done", {
          mode: "single",
          results: [
            {
              agent: "bg-runner",
              task: "后台任务",
              exitCode: 0,
              usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
              finalOutput: "后台完成",
            },
          ],
        })}
        error={false}
        expanded
        argsComplete
      />,
    );

    expect(markup).toContain("等待全部后台任务完成");
    expect(markup).toContain("bg-runner");
    expect(markup).toContain("后台完成");
  });

  it("异步提交只展示后台启动提示", () => {
    const markup = renderToStaticMarkup(
      <ToolContent
        name="subagent"
        args={{ agent: "researcher", task: "调研", async: true }}
        result={toolResult("submitted", { mode: "single", results: [], asyncId: "abc123" })}
        error={false}
        expanded
        argsComplete
      />,
    );

    expect(markup).toContain("已在后台启动（ID: abc123）");
    expect(markup).toContain("异步执行");
  });
});

describe("memory 工具详情", () => {
  it("add 以 diff 风格展示内容并给出人话结果", () => {
    const details = { success: true, target: "project", usage: "120/5000", entry_count: 3 };
    const markup = renderToStaticMarkup(
      <ToolContent
        name="memory"
        args={{ action: "add", target: "project", content: "用户偏好中文回复" }}
        result={toolResult(JSON.stringify(details), details)}
        error={false}
        expanded
        argsComplete
      />,
    );

    expect(markup).toContain("用户偏好中文回复");
    expect(markup).toContain("tool-diff-line-add");
    expect(markup).toContain("已记住 · 项目记忆");
    expect(markup).toContain("容量 120/5000");
    expect(markup).not.toContain("&quot;success&quot;");
  });

  it("replace 同时展示旧值与新值", () => {
    const markup = renderToStaticMarkup(
      <ToolContent
        name="memory"
        args={{ action: "replace", target: "memory", old_text: "旧偏好", content: "新偏好" }}
        result={undefined}
        error={false}
        expanded
        argsComplete
      />,
    );

    expect(markup).toContain("tool-diff-line-remove");
    expect(markup).toContain("旧偏好");
    expect(markup).toContain("tool-diff-line-add");
    expect(markup).toContain("新偏好");
  });

  it("错误路径从 JSON 文本兜底解析错误信息", () => {
    const markup = renderToStaticMarkup(
      <ToolContent
        name="memory"
        args={{ action: "add", target: "memory" }}
        result={toolResult(JSON.stringify({ success: false, error: "Content is required for 'add' action." }), {})}
        error
        expanded
        argsComplete
      />,
    );

    expect(markup).toContain("Content is required");
    expect(markup).toContain('data-tone="destructive"');
    expect(markup).not.toContain("&quot;success&quot;");
  });

  it("memory_search 只展示可读结果文本，不展示参数 JSON", () => {
    const markup = renderToStaticMarkup(
      <ToolContent
        name="memory_search"
        args={{ query: "auth 配置", limit: 5 }}
        result={toolResult('Found 1 memories matching "auth 配置":')}
        error={false}
        expanded
        argsComplete
      />,
    );

    expect(markup).toContain("Found 1 memories");
    expect(markup).not.toContain("&quot;query&quot;");
  });

  it("skill_manage create 展示描述与成功提示", () => {
    const details = { success: true, skillId: "global:demo", message: "Skill 'demo' created." };
    const markup = renderToStaticMarkup(
      <ToolContent
        name="skill_manage"
        args={{ action: "create", name: "demo", scope: "global", description: "演示技能" }}
        result={toolResult(JSON.stringify(details), details)}
        error={false}
        expanded
        argsComplete
      />,
    );

    expect(markup).toContain("演示技能");
    expect(markup).toContain("Skill &#x27;demo&#x27; created.");
    expect(markup).not.toContain("&quot;skillId&quot;");
  });
});

describe("tool TUI formatting", () => {
  it.each([
    ["/Users/test/project/src/main.ts", "/Users/test/project", "src/main.ts"],
    ["src/../main.ts", "/Users/test/project", "main.ts"],
    ["../other/main.ts", "/Users/test/project", "/Users/test/other/main.ts"],
    ["C:\\Workspace\\Project\\src\\main.ts", "c:\\workspace\\project", "src/main.ts"],
    ["/Users/test/other/main.ts", "/Users/test/project", "/Users/test/other/main.ts"],
  ])("按项目 cwd 格式化工具路径 %#", (path, cwd, expected) => {
    expect(projectDisplayToolPath(path, cwd)).toBe(expected);
  });

  it("解包 Pi toolResult 并去除 ANSI 控制符", () => {
    expect(parseToolResult(toolResult("\u001b[31mfailed\u001b[0m", { source: "test" }))).toEqual({
      text: "failed",
      details: { source: "test" },
    });
  });

  it("保留图像结果供展开 content 渲染", () => {
    const result = {
      content: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
    };
    const parsed = parseToolResult(result);
    const markup = renderToStaticMarkup(
      <ToolContent name="read" args={{ path: "image.png" }} result={result} error={false} expanded argsComplete />,
    );

    expect(parsed?.images).toEqual([{ data: "aW1hZ2U=", mimeType: "image/png" }]);
    expect(markup).toContain('src="data:image/png;base64,aW1hZ2U="');
  });

  it("解析 TUI 带行号 diff", () => {
    expect(parseRenderedToolDiff(toolResult("done", { diff: "-12 old\n+12 new" }))).toEqual([
      { type: "remove", lineNumber: "12", text: "old" },
      { type: "add", lineNumber: "12", text: "new" },
    ]);
  });

  it.each([
    [{ edits: JSON.stringify([{ oldText: "old", newText: "new" }]) }, "old", "new"],
    [{ oldText: "legacy-old", newText: "legacy-new" }, "legacy-old", "legacy-new"],
  ])("兼容 edit 参数格式 %#", (args, oldText, newText) => {
    const markup = renderToStaticMarkup(
      <ToolContent name="edit" args={args} result={undefined} error={false} expanded={false} argsComplete />,
    );

    expect(markup).toContain(`>${oldText}</span>`);
    expect(markup).toContain(`>${newText}</span>`);
  });

  it("标记 EOF 换行变化", () => {
    expect(diffToolEdit("line", "line\n")).toContainEqual({ type: "meta", text: "旧内容末尾无换行" });
    expect(diffToolEdit("line\n", "line")).toContainEqual({ type: "meta", text: "新内容末尾无换行" });
  });

  it("限制大 edit diff 的渲染行数", () => {
    const oldText = Array.from({ length: 700 }, (_, index) => `old-${index}`).join("\n");
    const newText = Array.from({ length: 700 }, (_, index) => `new-${index}`).join("\n");
    const lines = diffToolEdit(oldText, newText);

    expect(lines.length).toBeLessThanOrEqual(500);
    expect(lines).toContainEqual(expect.objectContaining({ type: "meta", text: expect.stringContaining("已省略") }));
  });
});

function renderToolView(props: ToolCallMessagePartProps): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <ToolView {...props} />
    </TooltipProvider>,
  );
}

function toolResult(text: string, details?: Readonly<Record<string, unknown>>) {
  return { content: [{ type: "text", text }], ...(details ? { details } : {}) };
}

function toolCall(overrides: Partial<ToolCallMessagePartProps>): ToolCallMessagePartProps {
  return {
    type: "tool-call",
    toolCallId: "tool-call",
    toolName: "write",
    args: {},
    argsText: "{}",
    status: { type: "complete" },
    addResult: () => undefined,
    resume: () => undefined,
    respondToApproval: () => undefined,
    ...overrides,
  } as ToolCallMessagePartProps;
}
