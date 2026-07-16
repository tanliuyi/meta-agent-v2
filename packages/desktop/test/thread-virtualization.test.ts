import { describe, expect, it } from "vitest";
import {
  buildThreadTurns,
  didUserScrollUp,
  isScrollerAtBottom,
  partitionThreadTurn,
  projectThreadMessageRows,
  resolveThreadScrollState,
  stabilizeThreadTurnIds,
  type ThreadMessageRow,
} from "../src/renderer/src/components/chat/thread-virtualization.ts";

describe("thread virtualization", () => {
  it("为空消息返回空 turn", () => {
    expect(buildThreadTurns([])).toEqual([]);
  });

  it("把 assistant/system 开头的消息归入 bootstrap turn", () => {
    expect(
      buildThreadTurns([
        { id: "system", role: "system" },
        { id: "assistant-1", role: "assistant" },
        { id: "assistant-2", role: "assistant" },
      ]),
    ).toEqual([{ id: "system", messageIds: ["system", "assistant-1", "assistant-2"] }]);
  });

  it("按 user 边界保留连续 user 与混合响应顺序", () => {
    expect(
      buildThreadTurns([
        { id: "user-1", role: "user" },
        { id: "assistant-1", role: "assistant" },
        { id: "system", role: "system" },
        { id: "user-2", role: "user" },
        { id: "user-3", role: "user" },
        { id: "assistant-2", role: "assistant" },
      ]),
    ).toEqual([
      { id: "user-1", messageIds: ["user-1", "assistant-1", "system"] },
      { id: "user-2", messageIds: ["user-2"] },
      { id: "user-3", messageIds: ["user-3", "assistant-2"] },
    ]);
  });

  it("末尾消息增删不改变既有 turn ID", () => {
    const initial = buildThreadTurns([
      { id: "user-1", role: "user" },
      { id: "assistant-1", role: "assistant" },
      { id: "user-2", role: "user" },
    ]);
    const appended = buildThreadTurns([
      { id: "user-1", role: "user" },
      { id: "assistant-1", role: "assistant" },
      { id: "user-2", role: "user" },
      { id: "assistant-2", role: "assistant" },
    ]);

    expect(initial.map(({ id }) => id)).toEqual(["user-1", "user-2"]);
    expect(appended.map(({ id }) => id)).toEqual(["user-1", "user-2"]);
  });

  it("将最终回答前的 assistant 消息统一归入过程区域", () => {
    const turn = {
      id: "user",
      messageIds: ["user", "reasoning-1", "tool-1", "reasoning-2", "answer"],
    };
    const roles = new Map<string, ThreadMessageRow["role"]>([
      ["user", "user"],
      ["reasoning-1", "assistant"],
      ["tool-1", "assistant"],
      ["reasoning-2", "assistant"],
      ["answer", "assistant"],
    ]);

    expect(partitionThreadTurn(turn, roles)).toEqual({
      leadingMessageIds: ["user"],
      processMessageIds: ["reasoning-1", "tool-1", "reasoning-2"],
      answerMessageIds: ["answer"],
    });
  });

  it("实时单 assistant 消息不创建额外 turn 级过程区域", () => {
    const turn = { id: "user", messageIds: ["user", "assistant"] };
    const roles = new Map<string, ThreadMessageRow["role"]>([
      ["user", "user"],
      ["assistant", "assistant"],
    ]);

    expect(partitionThreadTurn(turn, roles)).toEqual({
      leadingMessageIds: ["user"],
      processMessageIds: [],
      answerMessageIds: ["assistant"],
    });
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

  it("用 1,000 条历史消息生成稳定的 500 个 turn", () => {
    const rows = Array.from(
      { length: 1_000 },
      (_, index): ThreadMessageRow => ({
        id: `message-${index}`,
        role: index % 2 === 0 ? "user" : "assistant",
      }),
    );
    const turns = buildThreadTurns(rows);

    expect(turns).toHaveLength(500);
    expect(turns[0]).toEqual({ id: "message-0", messageIds: ["message-0", "message-1"] });
    expect(turns.at(-1)).toEqual({ id: "message-998", messageIds: ["message-998", "message-999"] });
  });

  it("成员和 role 不变时复用稳定 rows 引用", () => {
    const previous: readonly ThreadMessageRow[] = [
      { id: "user", role: "user" },
      { id: "assistant", role: "assistant" },
    ];
    const unchanged = projectThreadMessageRows(previous, [
      { id: "user", role: "user" },
      { id: "assistant", role: "assistant" },
    ]);
    const changed = projectThreadMessageRows(previous, [
      { id: "user", role: "user" },
      { id: "assistant", role: "system" },
    ]);

    expect(unchanged).toBe(previous);
    expect(changed).not.toBe(previous);
    expect(changed).toEqual([
      { id: "user", role: "user" },
      { id: "assistant", role: "system" },
    ]);
  });

  it("使用阈值判断底部", () => {
    expect(isScrollerAtBottom({ scrollTop: 596, scrollHeight: 1_000, clientHeight: 400 }, 4)).toBe(true);
    expect(isScrollerAtBottom({ scrollTop: 595, scrollHeight: 1_000, clientHeight: 400 }, 4)).toBe(false);
  });

  it("仅把内容和 viewport 高度稳定时的 scrollTop 下降识别为用户上滚", () => {
    const previous = { scrollTop: 600, scrollHeight: 1_000, clientHeight: 400 };
    expect(didUserScrollUp(previous, { ...previous, scrollTop: 580 })).toBe(true);
    expect(didUserScrollUp(previous, { ...previous, scrollTop: 580, scrollHeight: 1_020 })).toBe(false);
    expect(didUserScrollUp(previous, { ...previous, scrollTop: 580, clientHeight: 398 })).toBe(false);
  });

  it("pinned 内容增长造成瞬时离底时保持逻辑底部状态", () => {
    expect(
      resolveThreadScrollState({
        wasPinned: true,
        physicallyAtBottom: false,
        userScrolledUp: false,
      }),
    ).toEqual({ pinned: true, atBottom: true });
  });

  it("只在明确用户上滚时从 pinned 切换为 detached", () => {
    expect(
      resolveThreadScrollState({
        wasPinned: true,
        physicallyAtBottom: false,
        userScrolledUp: true,
      }),
    ).toEqual({ pinned: false, atBottom: false });
    expect(
      resolveThreadScrollState({
        wasPinned: false,
        physicallyAtBottom: false,
        userScrolledUp: false,
      }),
    ).toEqual({ pinned: false, atBottom: false });
  });
});
