import type { PartState } from "@assistant-ui/react";
import { describe, expect, it } from "vitest";
import {
  createProcessGroupBy,
  hasFinalResponseText,
  summarizeChainOfThought,
} from "../src/renderer/src/components/chat/message-part-grouping.ts";

const COMPLETE = { type: "complete" } as const;

describe("message part grouping", () => {
  it("运行中将过程 text 与相邻 reasoning/tool 纳入外层过程组", () => {
    const parts = [
      { type: "reasoning", text: "分析", status: COMPLETE },
      { type: "reasoning", text: "补充分析", status: COMPLETE },
      { type: "tool-call", toolCallId: "tool", toolName: "read", args: {}, status: COMPLETE },
      { type: "text", text: "中间说明", status: COMPLETE },
      { type: "reasoning", text: "继续分析", status: COMPLETE },
      { type: "tool-call", toolCallId: "tool-2", toolName: "write", args: {}, status: COMPLETE },
    ] satisfies PartState[];

    const groupBy = createProcessGroupBy(parts, true);
    expect(parts.map((part) => groupBy(part, {}))).toEqual([
      ["group-process", "group-chainOfThought"],
      ["group-process", "group-chainOfThought"],
      ["group-process", "group-chainOfThought"],
      ["group-process"],
      ["group-process", "group-chainOfThought"],
      ["group-process", "group-chainOfThought"],
    ]);
  });

  it("run_end 后仅将最后一段非空 text 留在过程组外", () => {
    const parts = [
      { type: "reasoning", text: "分析", status: COMPLETE },
      { type: "text", text: "阶段说明", status: COMPLETE },
      { type: "tool-call", toolCallId: "tool", toolName: "read", args: {}, status: COMPLETE },
      { type: "text", text: "最终回复", status: COMPLETE },
    ] satisfies PartState[];
    const groupBy = createProcessGroupBy(parts, false);

    expect(parts.map((part) => groupBy(part, {}))).toEqual([
      ["group-process", "group-chainOfThought"],
      ["group-process"],
      ["group-process", "group-chainOfThought"],
      [],
    ]);
    expect(hasFinalResponseText(parts)).toBe(true);
  });

  it("run_end 后没有最终 text 时保持整个过程组", () => {
    const parts = [
      { type: "text", text: "阶段说明", status: COMPLETE },
      { type: "tool-call", toolCallId: "tool", toolName: "read", args: {}, status: COMPLETE },
      { type: "text", text: "", status: COMPLETE },
    ] satisfies PartState[];
    const groupBy = createProcessGroupBy(parts, false);

    expect(parts.map((part) => groupBy(part, {}))).toEqual([
      ["group-process"],
      ["group-process", "group-chainOfThought"],
      ["group-process"],
    ]);
    expect(hasFinalResponseText(parts)).toBe(false);
  });

  it("按工具语义去重汇总折叠标题", () => {
    const parts = [
      { type: "reasoning", text: "分析", status: COMPLETE },
      { type: "tool-call", toolCallId: "read-1", toolName: "read", args: {}, status: COMPLETE },
      { type: "tool-call", toolCallId: "read-2", toolName: "read", args: {}, status: COMPLETE },
      { type: "tool-call", toolCallId: "edit", toolName: "edit", args: {}, status: COMPLETE },
      { type: "tool-call", toolCallId: "bash", toolName: "bash", args: {}, status: COMPLETE },
    ] satisfies PartState[];

    expect(summarizeChainOfThought(parts, [0, 1, 2, 3, 4])).toBe("读取了一些文件，修改了一些文件，执行了一些命令");
    expect(summarizeChainOfThought(parts, [0])).toBe("思考过程");
  });

  it("未知扩展工具使用通用语义", () => {
    const parts = [
      { type: "tool-call", toolCallId: "custom", toolName: "custom_tool", args: {}, status: COMPLETE },
    ] satisfies PartState[];

    expect(summarizeChainOfThought(parts, [0])).toBe("使用了其他工具");
  });

  it("工具类型较多时限制标题长度", () => {
    const parts = [
      { type: "tool-call", toolCallId: "read", toolName: "read", args: {}, status: COMPLETE },
      { type: "tool-call", toolCallId: "edit", toolName: "edit", args: {}, status: COMPLETE },
      { type: "tool-call", toolCallId: "bash", toolName: "bash", args: {}, status: COMPLETE },
      { type: "tool-call", toolCallId: "grep", toolName: "grep", args: {}, status: COMPLETE },
    ] satisfies PartState[];

    expect(summarizeChainOfThought(parts, [0, 1, 2, 3])).toBe("读取了一些文件，修改了一些文件，执行了一些命令等操作");
  });
});
