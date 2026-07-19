import type { GroupByContext, PartState } from "@assistant-ui/react";
import { describe, expect, it } from "vitest";
import {
  createRunGroupPart,
  groupMessagePart,
  hasFinalResponseText,
  hasTextAfterGroup,
  summarizeChainOfThought,
} from "../src/renderer/src/components/chat/message-part-grouping.ts";

const COMPLETE = { type: "complete" } as const;

describe("message part grouping", () => {
  it("仅将 reasoning 与 tool 纳入思考过程组", () => {
    const parts = [
      { type: "reasoning", text: "分析", status: COMPLETE },
      { type: "reasoning", text: "补充分析", status: COMPLETE },
      { type: "tool-call", toolCallId: "tool", toolName: "read", args: {}, status: COMPLETE },
      { type: "text", text: "中间说明", status: COMPLETE },
      { type: "reasoning", text: "继续分析", status: COMPLETE },
      { type: "tool-call", toolCallId: "tool-2", toolName: "write", args: {}, status: COMPLETE },
    ] satisfies PartState[];

    expect(parts.map((part) => groupMessagePart(part, {}))).toEqual([
      ["group-chainOfThought"],
      ["group-chainOfThought"],
      ["group-chainOfThought"],
      [],
      ["group-chainOfThought"],
      ["group-chainOfThought"],
    ]);
  });

  it("外层 run group 包含中间消息，并保留内层 step group", () => {
    const parts = [
      { type: "text", text: "先检查实现", status: COMPLETE },
      { type: "reasoning", text: "分析", status: COMPLETE },
      { type: "tool-call", toolCallId: "read", toolName: "read", args: {}, status: COMPLETE },
      { type: "text", text: "继续修改", status: COMPLETE },
      { type: "reasoning", text: "复核", status: COMPLETE },
      { type: "tool-call", toolCallId: "check", toolName: "bash", args: {}, status: COMPLETE },
      { type: "text", text: "最终回复", status: COMPLETE },
    ] satisfies PartState[];

    expect(runGroupPaths(parts)).toEqual([
      ["group-runActivity"],
      ["group-runActivity", "group-chainOfThought"],
      ["group-runActivity", "group-chainOfThought"],
      ["group-runActivity"],
      ["group-runActivity", "group-chainOfThought"],
      ["group-runActivity", "group-chainOfThought"],
      [],
    ]);
  });

  it("分组函数暴露稳定 memo key，且查找 part 不依赖线性 indexOf", () => {
    const parts = [
      { type: "reasoning", text: "分析", status: COMPLETE },
      { type: "text", text: "回复", status: COMPLETE },
    ] satisfies PartState[];
    Object.defineProperty(parts, "indexOf", {
      value: () => {
        throw new Error("不应线性查找 part");
      },
    });

    const groupPart = createRunGroupPart(parts);

    expect(Reflect.get(groupPart, Symbol.for("@assistant-ui/groupBy.memoKey"))).toBe("pi-run-activity:v1");
    expect(parts.map((part) => groupPart(part, {}))).toEqual([["group-runActivity", "group-chainOfThought"], []]);
  });

  it("取消或错误结束且没有最终 text 时保留完整 activity group", () => {
    const parts = [
      { type: "reasoning", text: "分析", status: COMPLETE },
      { type: "text", text: "正在调用工具", status: COMPLETE },
      { type: "tool-call", toolCallId: "tool", toolName: "read", args: {}, status: COMPLETE },
    ] satisfies PartState[];

    expect(runGroupPaths(parts)).toEqual([
      ["group-runActivity", "group-chainOfThought"],
      ["group-runActivity"],
      ["group-runActivity", "group-chainOfThought"],
    ]);
  });

  it("普通通知和其他 pi-notice 保持在 run group 内，只有压缩 notice 打断折叠", () => {
    const parts = [
      { type: "reasoning", text: "分析", status: COMPLETE },
      { type: "data", name: "pi-notice", data: { noticeType: "custom" }, status: COMPLETE },
      { type: "data", name: "pi-notice", data: { noticeType: "notification" }, status: COMPLETE },
      { type: "data", name: "pi-notice", data: { noticeType: "compaction" }, status: COMPLETE },
      { type: "data", name: "extension-data", data: {}, status: COMPLETE },
      { type: "text", text: "最终回复", status: COMPLETE },
    ] satisfies PartState[];

    expect(runGroupPaths(parts)).toEqual([
      ["group-runActivity", "group-chainOfThought"],
      ["group-runActivity"],
      ["group-runActivity"],
      [],
      [],
      [],
    ]);
  });

  it("notification 保持在最终回复之前，不改变 final text 判断", () => {
    const parts = [
      { type: "reasoning", text: "分析", status: COMPLETE },
      { type: "data", name: "pi-notice", data: { noticeType: "notification" }, status: COMPLETE },
      { type: "text", text: "最终回复", status: COMPLETE },
    ] satisfies PartState[];

    expect(runGroupPaths(parts)).toEqual([["group-runActivity", "group-chainOfThought"], ["group-runActivity"], []]);
    expect(hasTextAfterGroup(parts, [0, 1])).toBe(true);
  });

  it("最终回复后的 notification 不隐藏 assistant 消息操作栏", () => {
    const parts = [
      { type: "reasoning", text: "分析", status: COMPLETE },
      { type: "text", text: "最终回复", status: COMPLETE },
      { type: "data", name: "pi-notice", data: { noticeType: "notification" }, status: COMPLETE },
    ] satisfies PartState[];

    expect(hasFinalResponseText(parts)).toBe(true);
    expect(hasFinalResponseText([parts[0]!, parts[2]!])).toBe(false);
  });

  it("用户引导类 standalone tool 保持在 run group 外", () => {
    const parts = [
      { type: "reasoning", text: "需要用户确认", status: COMPLETE },
      { type: "tool-call", toolCallId: "ask", toolName: "ask_user", args: {}, status: COMPLETE },
    ] satisfies PartState[];
    const context = {
      toolUIs: { ask_user: [{ render: () => null, standalone: true }] },
    } satisfies GroupByContext;

    expect(runGroupPaths(parts, context)).toEqual([["group-runActivity", "group-chainOfThought"], []]);
  });

  it("仅在组后出现 text 时结束自动展开", () => {
    const parts = [
      { type: "reasoning", text: "分析", status: COMPLETE },
      { type: "tool-call", toolCallId: "read", toolName: "read", args: {}, status: COMPLETE },
      { type: "tool-call", toolCallId: "edit", toolName: "edit", args: {}, status: COMPLETE },
    ] satisfies PartState[];

    expect(hasTextAfterGroup(parts, [0, 1])).toBe(false);
    expect(hasTextAfterGroup([...parts, { type: "text", text: "结果", status: COMPLETE }], [0, 1, 2])).toBe(true);
  });

  it("按工具语义去重汇总折叠标题", () => {
    const parts = [
      { type: "reasoning", text: "分析", status: COMPLETE },
      { type: "tool-call", toolCallId: "read-1", toolName: "read", args: {}, status: COMPLETE },
      { type: "tool-call", toolCallId: "read-2", toolName: "read", args: {}, status: COMPLETE },
      { type: "tool-call", toolCallId: "edit", toolName: "edit", args: {}, status: COMPLETE },
      { type: "tool-call", toolCallId: "bash", toolName: "bash", args: {}, status: COMPLETE },
    ] satisfies PartState[];

    expect(summarizeChainOfThought(parts, [0, 1, 2, 3, 4])).toBe("读取一些文件，修改一些文件，执行一些命令");
    expect(summarizeChainOfThought(parts, [0])).toBe("思考过程");
  });

  it("未知扩展工具使用通用语义", () => {
    const parts = [
      { type: "tool-call", toolCallId: "custom", toolName: "custom_tool", args: {}, status: COMPLETE },
    ] satisfies PartState[];

    expect(summarizeChainOfThought(parts, [0])).toBe("使用其他工具");
  });

  it("工具类型较多时限制标题长度", () => {
    const parts = [
      { type: "tool-call", toolCallId: "read", toolName: "read", args: {}, status: COMPLETE },
      { type: "tool-call", toolCallId: "edit", toolName: "edit", args: {}, status: COMPLETE },
      { type: "tool-call", toolCallId: "bash", toolName: "bash", args: {}, status: COMPLETE },
      { type: "tool-call", toolCallId: "grep", toolName: "grep", args: {}, status: COMPLETE },
    ] satisfies PartState[];

    expect(summarizeChainOfThought(parts, [0, 1, 2, 3])).toBe("读取一些文件，修改一些文件，执行一些命令等操作");
  });
});

function runGroupPaths(parts: readonly PartState[], context: GroupByContext = {}): readonly (readonly string[])[] {
  const groupPart = createRunGroupPart(parts);
  return parts.map((part) => groupPart(part, context));
}
