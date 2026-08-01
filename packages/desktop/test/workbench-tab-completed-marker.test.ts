import { describe, expect, it } from "vitest";
import { createCompletedMarkerAutoClear } from "../src/renderer/src/state/completed-marker-auto-clear.ts";
import { createDesktopStore, dispatchDesktop } from "../src/renderer/src/state/desktop-store.ts";
import type { Thread } from "../src/shared/contracts.ts";

const thread: Thread = {
  id: "child",
  projectId: "p",
  title: "子会话",
  createdAt: 1,
  updatedAt: 1,
  messageCount: 0,
  preview: "",
  archived: false,
  running: false,
  parentThreadId: "parent",
  origin: "subagent",
};

function completedThread(): Thread {
  return { ...thread, running: false, completed: true, updatedAt: 2 };
}

/** workbench tab 活动可见期间的运行完成标记清除（与主路由“打开会话即视为已查看”一致的持续清除）。 */
describe("workbench active tab completed-marker auto clear", () => {
  it("会话在活动 tab 中运行结束时持续清除 completed 标记", () => {
    const store = createDesktopStore();
    dispatchDesktop(store, {
      type: "project-threads-loaded",
      projectId: "p",
      threads: [{ ...thread, running: true }],
    });

    // tab 活动可见：挂载持续清除器（SessionContent 仅活动 tab 渲染）。
    const autoClear = createCompletedMarkerAutoClear({
      store,
      projectId: "p",
      threadId: "child",
      dispatchViewed: () => dispatchDesktop(store, { type: "thread-viewed", projectId: "p", threadId: "child" }),
    });
    try {
      // 运行中无标记。
      expect(store.getState().threadCatalogs.p?.[0]?.completed).toBeUndefined();

      // 正在查看时运行结束：标记被置位后立即清除。
      dispatchDesktop(store, {
        type: "thread-summary-updated",
        projectId: "p",
        threadId: "child",
        title: thread.title,
        updatedAt: 2,
        running: false,
      });
      expect(store.getState().threadCatalogs.p?.[0]?.running).toBe(false);
      expect(store.getState().threadCatalogs.p?.[0]?.completed).toBeUndefined();

      // 再次运行并结束：持续清除，不残留标记。
      dispatchDesktop(store, {
        type: "thread-summary-updated",
        projectId: "p",
        threadId: "child",
        title: thread.title,
        updatedAt: 3,
        running: true,
      });
      dispatchDesktop(store, {
        type: "thread-summary-updated",
        projectId: "p",
        threadId: "child",
        title: thread.title,
        updatedAt: 4,
        running: false,
      });
      expect(store.getState().threadCatalogs.p?.[0]?.completed).toBeUndefined();

      // 其他会话的 completed 标记不受影响。
      dispatchDesktop(store, {
        type: "thread-catalog-upserted",
        thread: { ...thread, id: "other", running: false, completed: true, updatedAt: 5 },
      });
      expect(store.getState().threadCatalogs.p?.find(({ id }) => id === "other")?.completed).toBe(true);
    } finally {
      autoClear.dispose();
    }
  });

  it("挂载时已有 completed 标记视为已查看并清除", () => {
    const store = createDesktopStore();
    dispatchDesktop(store, { type: "project-threads-loaded", projectId: "p", threads: [completedThread()] });
    expect(store.getState().threadCatalogs.p?.[0]?.completed).toBe(true);

    const autoClear = createCompletedMarkerAutoClear({
      store,
      projectId: "p",
      threadId: "child",
      dispatchViewed: () => dispatchDesktop(store, { type: "thread-viewed", projectId: "p", threadId: "child" }),
    });
    try {
      expect(store.getState().threadCatalogs.p?.[0]?.completed).toBeUndefined();
    } finally {
      autoClear.dispose();
    }
  });

  it("dispose（tab 不再活动）后不再清除标记", () => {
    const store = createDesktopStore();
    dispatchDesktop(store, { type: "project-threads-loaded", projectId: "p", threads: [{ ...thread, running: true }] });
    const autoClear = createCompletedMarkerAutoClear({
      store,
      projectId: "p",
      threadId: "child",
      dispatchViewed: () => dispatchDesktop(store, { type: "thread-viewed", projectId: "p", threadId: "child" }),
    });
    autoClear.dispose();

    dispatchDesktop(store, {
      type: "thread-summary-updated",
      projectId: "p",
      threadId: "child",
      title: thread.title,
      updatedAt: 2,
      running: false,
    });
    expect(store.getState().threadCatalogs.p?.[0]?.completed).toBe(true);
  });
});
