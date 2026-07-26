import { describe, expect, it } from "vitest";
import { flattenVisibleThreadTree, threadTreeByArchiveState } from "../src/renderer/src/state/thread-list-commands.ts";
import type { Thread } from "../src/shared/contracts.ts";

describe("thread list tree", () => {
  it("groups descendants under roots and limits only root sessions", () => {
    const roots = threadTreeByArchiveState(
      [
        thread("parent-a", 50),
        thread("running-child", 20, { parentThreadId: "parent-a", running: true }),
        thread("newer-child", 40, { parentThreadId: "parent-a" }),
        thread("parent-b", 30),
        thread("parent-c", 10),
      ],
      false,
      2,
    );

    expect(roots.map(({ thread: item }) => item.id)).toEqual(["parent-a", "parent-b"]);
    expect(roots[0]?.children.map(({ thread: item }) => item.id)).toEqual(["running-child", "newer-child"]);
  });

  it("keeps every root collapsed by default, including roots with running descendants", () => {
    const roots = threadTreeByArchiveState(
      [
        thread("parent", 30),
        thread("child", 20, { parentThreadId: "parent", running: true }),
        thread("other-parent", 10),
      ],
      false,
      10,
    );

    expect(flattenVisibleThreadTree(roots, new Set()).map(({ thread: item }) => item.id)).toEqual([
      "parent",
      "other-parent",
    ]);
  });

  it("describes ancestor continuation and last-child connectors for deep trees", () => {
    const roots = threadTreeByArchiveState(
      [
        thread("parent", 50),
        thread("child-a", 40, { parentThreadId: "parent" }),
        thread("child-b", 30, { parentThreadId: "parent" }),
        thread("grandchild", 20, { parentThreadId: "child-a" }),
      ],
      false,
      10,
    );
    const visible = flattenVisibleThreadTree(roots, new Set(["parent", "child-a"]));

    expect(
      visible.map(({ thread: item, depth, ancestorContinuations, isLastChild }) => ({
        id: item.id,
        depth,
        ancestorContinuations,
        isLastChild,
      })),
    ).toEqual([
      { id: "parent", depth: 0, ancestorContinuations: [], isLastChild: true },
      { id: "child-a", depth: 1, ancestorContinuations: [], isLastChild: false },
      { id: "grandchild", depth: 2, ancestorContinuations: [true], isLastChild: true },
      { id: "child-b", depth: 1, ancestorContinuations: [], isLastChild: true },
    ]);
  });

  it("keeps orphaned and cyclic relationships visible as roots", () => {
    const roots = threadTreeByArchiveState(
      [
        thread("orphan", 30, { parentThreadId: "missing" }),
        thread("cycle-a", 20, { parentThreadId: "cycle-b" }),
        thread("cycle-b", 10, { parentThreadId: "cycle-a" }),
      ],
      false,
      10,
    );

    expect(roots.map(({ thread: item }) => item.id)).toEqual(["orphan", "cycle-a", "cycle-b"]);
  });
});

function thread(id: string, updatedAt: number, options: { parentThreadId?: string; running?: boolean } = {}): Thread {
  return {
    id,
    projectId: "project",
    title: id,
    createdAt: 1,
    updatedAt,
    messageCount: 0,
    preview: "",
    archived: false,
    running: options.running ?? false,
    ...(options.parentThreadId ? { parentThreadId: options.parentThreadId } : {}),
  };
}
