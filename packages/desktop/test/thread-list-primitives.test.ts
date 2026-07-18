import { describe, expect, it, vi } from "vitest";
import {
  COLLAPSED_THREAD_COUNT,
  isDesktopThreadItemForProject,
  nextRegularThreadId,
  nextThreadVisibleLimit,
  normalizeThreadTitle,
  preventPrimitiveThreadAction,
  resolveDesktopAdapterThread,
  resolveDesktopThreadItem,
  runControlledThreadAction,
  runPendingThreadAction,
  shouldOpenThread,
  type ThreadListItemIdentity,
  visibleRegularThreadIds,
} from "../src/renderer/src/state/thread-list-commands.ts";
import type { Project, Thread } from "../src/shared/contracts.ts";

const project: Project = {
  id: "project",
  name: "workspace",
  cwd: "C:/workspace",
  lastOpenedAt: 1,
  available: true,
};

const regularThread: Thread = {
  id: "regular",
  projectId: "project",
  title: "常规会话",
  createdAt: 1,
  updatedAt: 3,
  messageCount: 2,
  preview: "",
  archived: false,
  running: false,
};

const archivedThread: Thread = {
  ...regularThread,
  id: "archived",
  title: "归档会话",
  archived: true,
};

function threadListItem(overrides: Partial<ThreadListItemIdentity> = {}): ThreadListItemIdentity {
  return {
    id: "project:regular",
    remoteId: "regular",
    custom: { projectId: "project" },
    ...overrides,
  };
}

describe("thread-list primitives command bridge", () => {
  it("先阻止 primitive 默认 action，再且仅调用一次 Desktop command", () => {
    const calls: string[] = [];
    runControlledThreadAction({ preventDefault: () => calls.push("prevent") }, () => calls.push("command"));

    expect(calls).toEqual(["prevent", "command"]);
  });

  it("在 capture 阶段阻止 primitive 组合 handler 的默认提交", () => {
    const preventDefault = vi.fn();
    preventPrimitiveThreadAction({ preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  it("只通过 remoteId 解析当前 Project 的 Desktop session", () => {
    expect(resolveDesktopThreadItem(threadListItem(), "project", [regularThread, archivedThread])).toBe(regularThread);
    expect(() => resolveDesktopThreadItem(threadListItem({ remoteId: undefined }), "project", [regularThread])).toThrow(
      "assistant-ui thread 缺少 remoteId",
    );
    expect(resolveDesktopThreadItem(threadListItem({ remoteId: "missing" }), "project", [regularThread])).toBeNull();
    expect(() => resolveDesktopThreadItem(threadListItem(), "other-project", [regularThread])).toThrow(
      "assistant-ui thread 不属于当前 Project",
    );
  });

  it("Project 切换的过渡帧只忽略旧 Project item", () => {
    expect(isDesktopThreadItemForProject(threadListItem(), "project")).toBe(true);
    expect(
      isDesktopThreadItemForProject(
        threadListItem({ id: "old-project:regular", custom: { projectId: "old-project" } }),
        "project",
      ),
    ).toBe(false);
    expect(() => isDesktopThreadItemForProject(threadListItem({ custom: undefined }), "project")).toThrow(
      "assistant-ui thread 缺少 projectId",
    );
  });

  it("从全局 catalog 解析 Project，并在 React 提交前使用显式切换目标", () => {
    expect(resolveDesktopAdapterThread("project:regular", [project], { project: [regularThread] })).toEqual({
      project,
      threadId: regularThread.id,
    });
    const target = { ...project, id: "target" };
    expect(resolveDesktopAdapterThread("target:pending", [project], {}, target)).toEqual({
      project: target,
      threadId: "pending",
    });
    expect(() => resolveDesktopAdapterThread("missing:thread", [project], {})).toThrow(
      "Desktop session catalog 不包含",
    );
  });

  it("同一 pending key 只执行一次，同时发布开始和结束快照", async () => {
    const pending = new Set<string>();
    const snapshots: string[][] = [];
    let release: (() => void) | undefined;
    const task = new Promise<void>((resolve) => {
      release = resolve;
    });
    const action = vi.fn(() => task);
    const publish = (snapshot: ReadonlySet<string>) => snapshots.push([...snapshot]);

    const first = runPendingThreadAction(pending, "switch:regular", publish, action);
    const duplicate = await runPendingThreadAction(pending, "switch:regular", publish, action);
    expect(duplicate).toBe(false);
    expect(action).toHaveBeenCalledTimes(1);
    release?.();
    expect(await first).toBe(true);
    expect(snapshots).toEqual([["switch:regular"], []]);
  });

  it("规范化标题并选择下一条未归档 session", () => {
    expect(normalizeThreadTitle("  新标题  ")).toBe("新标题");
    expect(normalizeThreadTitle("   ")).toBeNull();
    expect(nextRegularThreadId([archivedThread, regularThread], "current")).toBe("regular");
    expect(nextRegularThreadId([archivedThread, regularThread], "regular")).toBeNull();
  });

  it("当前 active session 不触发重复 attach", () => {
    expect(shouldOpenThread("regular", "regular")).toBe(false);
    expect(shouldOpenThread("other", "regular")).toBe(true);
    expect(shouldOpenThread(null, "regular")).toBe(true);
  });

  it("默认显示 5 条，并且每次展开 10 条且不超过总数", () => {
    expect(COLLAPSED_THREAD_COUNT).toBe(5);
    expect(nextThreadVisibleLimit(COLLAPSED_THREAD_COUNT, 30)).toBe(15);
    expect(nextThreadVisibleLimit(15, 30)).toBe(25);
    expect(nextThreadVisibleLimit(25, 30)).toBe(30);
  });

  it("可见列表保持 catalog 顺序并排除归档会话", () => {
    const threads = Array.from(
      { length: 8 },
      (_, index): Thread => ({
        ...regularThread,
        id: `regular-${index}`,
      }),
    );
    threads.splice(2, 0, archivedThread);

    expect([...visibleRegularThreadIds(threads, COLLAPSED_THREAD_COUNT)]).toEqual([
      "regular-0",
      "regular-1",
      "regular-2",
      "regular-3",
      "regular-4",
    ]);
  });
});
