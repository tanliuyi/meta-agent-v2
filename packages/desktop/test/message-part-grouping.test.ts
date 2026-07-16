import type { PartState } from "@assistant-ui/react";
import { describe, expect, it } from "vitest";
import { createProcessGroupBy } from "../src/renderer/src/components/chat/message-part-grouping.ts";

const COMPLETE = { type: "complete" } as const;

describe("message part grouping", () => {
  it("完成后仅将最后一段文本留在过程外", () => {
    const parts = [
      { type: "reasoning", text: "分析", status: COMPLETE },
      { type: "text", text: "中间说明", status: COMPLETE },
      { type: "reasoning", text: "继续分析", status: COMPLETE },
      { type: "text", text: "最终回答", status: COMPLETE },
    ] satisfies PartState[];
    const groupBy = createProcessGroupBy(parts, false);

    expect(parts.map((part) => groupBy(part, {}))).toEqual([
      ["group-process", "group-reasoning"],
      ["group-process", "group-intermediate-text"],
      ["group-process", "group-reasoning"],
      [],
    ]);
  });

  it("运行中将所有文本留在统一过程内", () => {
    const parts = [
      { type: "reasoning", text: "分析", status: COMPLETE },
      { type: "text", text: "阶段说明", status: COMPLETE },
    ] satisfies PartState[];
    const groupBy = createProcessGroupBy(parts, true);

    expect(parts.map((part) => groupBy(part, {}))).toEqual([
      ["group-process", "group-reasoning"],
      ["group-process", "group-intermediate-text"],
    ]);
  });
});
