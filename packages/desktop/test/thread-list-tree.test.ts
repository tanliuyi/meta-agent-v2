import { describe, expect, it } from "vitest";
import {
  COLLAPSED_THREAD_COUNT,
  flattenVisibleThreadTree,
  threadTreeByArchiveState,
} from "../src/renderer/src/state/thread-list-commands.ts";
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
    expect(flattenVisibleThreadTree(roots, new Set())[0]).toMatchObject({
      childCount: 1,
      runningChildCount: 1,
    });
  });

  it("counts only directly running child sessions", () => {
    const roots = threadTreeByArchiveState(
      [
        thread("parent", 50),
        thread("running-child", 40, { parentThreadId: "parent", running: true }),
        thread("idle-child", 30, { parentThreadId: "parent" }),
        thread("running-grandchild", 20, { parentThreadId: "idle-child", running: true }),
      ],
      false,
      10,
    );

    const visible = flattenVisibleThreadTree(roots, new Set(["parent"]));

    expect(visible.find(({ thread: item }) => item.id === "parent")).toMatchObject({
      childCount: 2,
      runningChildCount: 1,
    });
    expect(visible.find(({ thread: item }) => item.id === "idle-child")).toMatchObject({
      childCount: 1,
      runningChildCount: 1,
    });
  });

  it("collapses each expanded child group with the same limit as root sessions", () => {
    const children = Array.from({ length: 18 }, (_, index) =>
      thread(`child-${index + 1}`, 100 - index, { parentThreadId: "parent" }),
    );
    const roots = threadTreeByArchiveState([thread("parent", 200), ...children], false, 10);

    const collapsed = flattenVisibleThreadTree(roots, new Set(["parent"]));
    expect(collapsed.map(({ thread: item }) => item.id)).toEqual([
      "parent",
      "child-1",
      "child-2",
      "child-3",
      "child-4",
      "child-5",
    ]);
    expect(collapsed.at(-1)?.siblingExpansions).toEqual([
      {
        parentThreadId: "parent",
        depth: 1,
        threadCount: 18,
        hasMore: true,
        expanded: false,
      },
    ]);

    const expanded = flattenVisibleThreadTree(
      roots,
      new Set(["parent"]),
      new Map([["parent", COLLAPSED_THREAD_COUNT + 10]]),
    );
    expect(expanded).toHaveLength(16);
    expect(expanded.at(-1)?.thread.id).toBe("child-15");
    expect(expanded.at(-1)?.siblingExpansions?.[0]).toMatchObject({ hasMore: true, expanded: true });
  });

  it("keeps nested child-group controls when their visible tails share a row", () => {
    const children = Array.from({ length: 6 }, (_, index) =>
      thread(`child-${index + 1}`, 100 - index, { parentThreadId: "parent" }),
    );
    const grandchildren = Array.from({ length: 6 }, (_, index) =>
      thread(`grandchild-${index + 1}`, 50 - index, { parentThreadId: "child-5" }),
    );
    const roots = threadTreeByArchiveState([thread("parent", 200), ...children, ...grandchildren], false, 10);

    const visible = flattenVisibleThreadTree(roots, new Set(["parent", "child-5"]));

    expect(visible.at(-1)?.thread.id).toBe("grandchild-5");
    expect(visible.at(-1)?.siblingExpansions?.map(({ parentThreadId }) => parentThreadId)).toEqual([
      "child-5",
      "parent",
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
