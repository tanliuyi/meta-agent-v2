import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { TooltipProvider } from "@renderer/shared/ui/tooltip-provider";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

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
} from "../src/renderer/src/components/chat/tools/tool-format.ts";

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

  it("bash content 默认完全折叠", () => {
    const partialResult = toolResult(Array.from({ length: 7 }, (_, index) => `line-${index + 1}`).join("\n"));
    const markup = renderToolView(
      toolCall({
        toolName: "bash",
        args: { command: "generate output" },
        status: { type: "running" },
        artifact: { execution: "running", partialResult },
      }),
    );

    expect(markup).toContain("generate output");
    expect(markup).toContain('data-cursor-position="end"');
    expect(markup).not.toContain("line-1");
  });

  it("展开后的 bash content 随 delta 原位更新", () => {
    const renderDelta = (result: unknown) =>
      renderToStaticMarkup(
        <ToolContent
          name="bash"
          args={{ command: "stream output" }}
          result={result}
          error={false}
          expanded
          argsComplete
        />,
      );
    const first = renderDelta(toolResult("one\ntwo"));
    const next = renderDelta(toolResult("one\ntwo\nthree\nfour\nfive\nsix"));

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

describe("tool TUI formatting", () => {
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
