import { describe, expect, it } from "vitest";
import {
  buildThreadTurns,
  mergeSelectedVirtualIndexes,
  stabilizeThreadTurnIds,
  type ThreadMessageRow,
} from "../src/renderer/src/components/chat/thread-virtualization.ts";

describe("thread virtualization", () => {
  it("按 user 边界将相邻输出归入同一 turn", () => {
    expect(
      buildThreadTurns([
        { id: "user-1", role: "user" },
        { id: "assistant-1", role: "assistant" },
        { id: "system", role: "system" },
        { id: "user-2", role: "user" },
      ]),
    ).toEqual([
      { id: "user-1", messageIds: ["user-1", "assistant-1", "system"] },
      { id: "user-2", messageIds: ["user-2"] },
    ]);
  });

  it("activity 行消失后丢弃旧选区中的越界索引", () => {
    expect(mergeSelectedVirtualIndexes([3, 4, 5], { start: 3, end: 6 }, 6)).toEqual([3, 4, 5]);
  });

  it("合并有效选区并过滤无效的默认索引", () => {
    expect(mergeSelectedVirtualIndexes([-1, 0, 3, 8, 10], { start: 1, end: 4 }, 10)).toEqual([0, 1, 2, 3, 4, 8]);
  });

  it("run finish 替换 user message ID 时复用原 turn ID", () => {
    const running = buildThreadTurns([
      { id: "optimistic-user", role: "user" },
      { id: "assistant", role: "assistant" },
    ]);
    const completed = buildThreadTurns([
      { id: "snapshot-user", role: "user" },
      { id: "assistant", role: "assistant" },
    ]);

    expect(stabilizeThreadTurnIds(running, completed)).toEqual([
      { id: "optimistic-user", messageIds: ["snapshot-user", "assistant"] },
    ]);
  });

  it("用 1,000 条历史消息生成 500 个 turn", () => {
    const messages = Array.from(
      { length: 1_000 },
      (_, index): ThreadMessageRow => ({
        id: `message-${index}`,
        role: index % 2 === 0 ? "user" : "assistant",
      }),
    );

    expect(buildThreadTurns(messages)).toHaveLength(500);
  });
});
