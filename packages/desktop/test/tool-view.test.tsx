import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { TooltipProvider } from "@renderer/shared/ui/tooltip-provider";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ToolView } from "../src/renderer/src/components/chat/tool-view.tsx";
import { ToolContent } from "../src/renderer/src/components/chat/tools/tool-content.tsx";

describe("ToolView", () => {
  it("用文字展示运行中的工具与目标", () => {
    const markup = renderToolView(
      toolCall({
        toolName: "write",
        args: { path: "src/main.ts" },
        status: { type: "running" },
        artifact: { execution: "running" },
      }),
    );

    expect(markup).toContain('data-tool-status="running"');
    expect(markup).not.toContain('class="tool-status-label running"');
    expect(markup).toContain("正在写入");
    expect(markup).toContain('class="tool-target tool-file-target"');
    expect(markup).toContain(">main.ts</button>");
    expect(markup).not.toContain(">src/main.ts</button>");
  });

  it("用文字展示失败的工具与目标", () => {
    const markup = renderToolView(
      toolCall({
        toolName: "write",
        args: { path: "src/main.ts" },
        status: { type: "incomplete", reason: "error" },
        artifact: { execution: "error" },
        isError: true,
      }),
    );

    expect(markup).toContain('data-tool-status="error"');
    expect(markup).not.toContain('class="tool-status-label error"');
    expect(markup).toContain("写入失败");
    expect(markup).toContain(">main.ts</button>");
  });

  it.each([
    ["read", { path: "/Users/test/project/src/read.ts" }, "read.ts"],
    ["write", { file_path: "C:\\project\\src\\write.ts" }, "write.ts"],
    ["edit", { path: "src/edit.ts" }, "edit.ts"],
  ])("%s 工具只展示文件名", (toolName, args, fileName) => {
    const markup = renderToolView(toolCall({ toolName, args, status: { type: "complete" } }));

    expect(markup).toContain(`>${fileName}</button>`);
  });

  it("将文件操作渲染为折叠触发器的同级按钮", () => {
    const markup = renderToolView(toolCall({ toolName: "read", args: { path: "src/read.ts" } }));
    const triggerStart = markup.indexOf("<button");
    const triggerEnd = markup.indexOf("</button>", triggerStart);
    const fileTarget = markup.indexOf('class="tool-target tool-file-target"');

    expect(triggerStart).toBeGreaterThanOrEqual(0);
    expect(triggerEnd).toBeLessThan(fileTarget);
  });

  it("保留 shell 命令的原始换行供两行样式截断", () => {
    const command = "printf first\nprintf second\nprintf third";
    const markup = renderToStaticMarkup(
      <ToolContent name="bash" args={{ command }} result={undefined} error={false} />,
    );

    expect(markup).toContain('<pre class="tool-command">');
    expect(markup).toContain(command);
  });

  it("通过 data-tone 暴露工具结果错误状态", () => {
    const markup = renderToStaticMarkup(<ToolContent name="read" args={{}} result="failed" error />);

    expect(markup).toContain('class="tool-result" data-tone="destructive"');
    expect(markup).not.toContain('class="tool-result error"');
  });
});

function renderToolView(props: ToolCallMessagePartProps): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <ToolView {...props} />
    </TooltipProvider>,
  );
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
