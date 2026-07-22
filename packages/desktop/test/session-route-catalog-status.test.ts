import { describe, expect, it } from "vitest";
import { selectSessionCatalogStatus } from "../src/renderer/src/app/routes/_chat.projects.$projectId.session.$threadId.tsx";
import { createDesktopStore, dispatchDesktop } from "../src/renderer/src/state/desktop-store.ts";
import type { Project, Thread } from "../src/shared/contracts.ts";

const project: Project = {
  id: "project",
  name: "workspace",
  cwd: "/workspace",
  lastOpenedAt: 1,
  available: true,
};

const thread: Thread = {
  id: "thread",
  projectId: project.id,
  title: "会话",
  createdAt: 1,
  updatedAt: 1,
  messageCount: 0,
  preview: "",
  archived: false,
  running: false,
};

describe("session route catalog status", () => {
  it("running summary 更新保持 ready，归档仍使 route 失效", () => {
    const store = createDesktopStore();
    store.setState(
      {
        ...store.getState(),
        projects: [project],
        threadCatalogs: { [project.id]: [thread] },
      },
      true,
    );

    expect(selectSessionCatalogStatus(store.getState(), project.id, thread.id)).toBe("ready");

    dispatchDesktop(store, {
      type: "thread-summary-updated",
      projectId: project.id,
      threadId: thread.id,
      title: "运行中会话",
      updatedAt: 2,
      running: true,
    });

    expect(selectSessionCatalogStatus(store.getState(), project.id, thread.id)).toBe("ready");

    dispatchDesktop(store, { type: "thread-archived", projectId: project.id, threadId: thread.id, archived: true });

    expect(selectSessionCatalogStatus(store.getState(), project.id, thread.id)).toBe("thread-invalid");
  });
});
