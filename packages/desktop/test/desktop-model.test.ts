import { describe, expect, it } from "vitest";
import { desktopReducer, INITIAL_STATE } from "../src/renderer/src/state/desktop-model.ts";
import type { Project, SessionBootstrap, Thread } from "../src/shared/contracts.ts";
import { PROTOCOL_VERSION } from "../src/shared/contracts.ts";

const project: Project = {
  id: "project",
  name: "workspace",
  cwd: "C:/workspace",
  lastOpenedAt: 1,
  available: true,
};

const thread: Thread = {
  id: "thread",
  projectId: project.id,
  title: "新会话",
  createdAt: 1,
  updatedAt: 1,
  messageCount: 0,
  preview: "",
  archived: false,
  running: false,
};

describe("desktop catalog reducer", () => {
  it("保留 Project 持久化顺序，更新 active Project 时不重排", () => {
    const first = { ...project, id: "first", name: "first", lastOpenedAt: 1 };
    const second = { ...project, id: "second", name: "second", lastOpenedAt: 2 };
    let state = desktopReducer(INITIAL_STATE, {
      type: "projects-loaded",
      projects: [first, second],
      activeProjectId: first.id,
    });

    expect(state.projects.map(({ id }) => id)).toEqual([first.id, second.id]);

    state = desktopReducer(state, {
      type: "project-upserted",
      project: { ...second, name: "second updated", lastOpenedAt: 99 },
    });

    expect(state.projects.map(({ id }) => id)).toEqual([first.id, second.id]);
    expect(state.projects[1]?.name).toBe("second updated");
    expect(state.activeProjectId).toBe(second.id);
  });

  it("新添加 Project 才改变列表结构", () => {
    const existing = { ...project, id: "existing" };
    const added = { ...project, id: "added" };
    let state = desktopReducer(INITIAL_STATE, {
      type: "projects-loaded",
      projects: [existing],
      activeProjectId: existing.id,
    });

    state = desktopReducer(state, { type: "project-upserted", project: added });

    expect(state.projects.map(({ id }) => id)).toEqual([added.id, existing.id]);
  });

  it("Project thread catalog 语义未变化时复用引用", () => {
    let state = desktopReducer(INITIAL_STATE, {
      type: "project-threads-loaded",
      projectId: project.id,
      threads: [thread],
    });
    const catalog = state.threadCatalogs[project.id];

    state = desktopReducer(state, {
      type: "project-threads-loaded",
      projectId: project.id,
      threads: [{ ...thread }],
    });

    expect(state.threadCatalogs[project.id]).toBe(catalog);
  });

  it("后台重新加载 thread catalog 时保留已有标题并刷新其他摘要字段", () => {
    let state = desktopReducer(INITIAL_STATE, {
      type: "project-threads-loaded",
      projectId: project.id,
      threads: [{ ...thread, title: "当前标题" }],
    });

    state = desktopReducer(state, {
      type: "project-threads-loaded",
      projectId: project.id,
      threads: [{ ...thread, title: "持久化旧标题", updatedAt: 2, messageCount: 1, preview: "最新消息" }],
    });

    expect(state.threadCatalogs[project.id]?.[0]).toMatchObject({
      title: "当前标题",
      updatedAt: 2,
      messageCount: 1,
      preview: "最新消息",
    });
  });

  it("cached control 只更新 thread summary，不进入全局 control 副本", () => {
    let state = desktopReducer(INITIAL_STATE, {
      type: "project-threads-loaded",
      projectId: project.id,
      threads: [thread, { ...thread, id: "newer", updatedAt: 3 }],
    });

    state = desktopReducer(state, {
      type: "thread-summary-updated",
      projectId: project.id,
      threadId: thread.id,
      title: "实时标题",
      updatedAt: 4,
      running: true,
    });

    expect(state.threadCatalogs[project.id]?.map(({ id }) => id)).toEqual([thread.id, "newer"]);
    expect(state.threadCatalogs[project.id]?.[0]).toMatchObject({ title: "实时标题", running: true });
    expect(state).not.toHaveProperty("controls");
  });

  it("subagent ordinary control 不用 Read from 前缀覆盖任务标题，但接受显式重命名", () => {
    const subagent: Thread = {
      ...thread,
      id: "subagent",
      title: "检查持久化 child",
      preview: "检查持久化 child",
      parentThreadId: thread.id,
      origin: "subagent",
    };
    let state = desktopReducer(INITIAL_STATE, {
      type: "project-threads-loaded",
      projectId: project.id,
      threads: [subagent],
    });

    state = desktopReducer(state, {
      type: "thread-summary-updated",
      projectId: project.id,
      threadId: subagent.id,
      title: "[Read from: plan.md]",
      updatedAt: 2,
      running: true,
    });
    expect(state.threadCatalogs[project.id]?.[0]).toMatchObject({
      title: "检查持久化 child",
      updatedAt: 2,
      running: true,
    });

    state = desktopReducer(state, {
      type: "thread-summary-updated",
      projectId: project.id,
      threadId: subagent.id,
      title: "用户重命名",
      updatedAt: 3,
      running: false,
    });
    expect(state.threadCatalogs[project.id]?.[0]).toMatchObject({ title: "用户重命名", running: false });
  });

  it("实时 upsert 已加载 Project 的 subagent summary，忽略未加载 catalog", () => {
    const subagent: Thread = {
      ...thread,
      id: "subagent",
      title: "检查改动",
      preview: "检查改动",
      updatedAt: 5,
      archived: true,
      running: true,
      parentThreadId: thread.id,
      origin: "subagent",
      agentName: "reviewer",
    };

    expect(desktopReducer(INITIAL_STATE, { type: "thread-catalog-upserted", thread: subagent })).toBe(INITIAL_STATE);

    let state = desktopReducer(INITIAL_STATE, {
      type: "project-threads-loaded",
      projectId: project.id,
      threads: [thread],
    });
    state = desktopReducer(state, { type: "thread-catalog-upserted", thread: subagent });
    state = desktopReducer(state, {
      type: "thread-catalog-upserted",
      thread: {
        ...thread,
        id: subagent.id,
        title: "[Read from: plan.md]",
        preview: "[Read from: plan.md]",
        updatedAt: 6,
        running: false,
      },
    });

    expect(state.threadCatalogs[project.id]).toHaveLength(2);
    expect(state.threadCatalogs[project.id]?.[0]).toMatchObject({
      id: "subagent",
      title: "检查改动",
      preview: "检查改动",
      archived: true,
      parentThreadId: thread.id,
      origin: "subagent",
      agentName: "reviewer",
      updatedAt: 6,
      running: false,
    });
  });

  it("materialized session 按 bootstrap 添加并去重", () => {
    let state = desktopReducer(INITIAL_STATE, { type: "thread-catalog-added", bootstrap: createBootstrap() });
    state = desktopReducer(state, { type: "thread-catalog-added", bootstrap: createBootstrap() });

    expect(state.threadCatalogs[project.id]).toHaveLength(1);
    expect(state.threadCatalogs[project.id]?.[0]).toMatchObject({ id: thread.id, title: "新会话" });
  });

  it("applies session tree removal and reparenting atomically", () => {
    const grandparent = { ...thread, id: "grandparent" };
    const parent = { ...thread, id: "parent", parentThreadId: "grandparent" };
    const child = { ...thread, id: "child", parentThreadId: "parent" };
    const grandchild = { ...thread, id: "grandchild", parentThreadId: "child" };
    let state = desktopReducer(INITIAL_STATE, {
      type: "project-threads-loaded",
      projectId: project.id,
      threads: [grandparent, parent, child, grandchild],
    });
    state = desktopReducer(state, {
      type: "session-tree-removed",
      projectId: project.id,
      removedThreadIds: ["parent"],
      reparentedThreads: [{ ...child, parentThreadId: "grandparent" }],
    });
    expect(state.threadCatalogs[project.id]).toEqual([
      grandparent,
      { ...child, parentThreadId: "grandparent" },
      grandchild,
    ]);
  });

  it("删除 Project 同时删除其 thread catalog，不影响其他 Project", () => {
    const other = { ...project, id: "other" };
    let state = desktopReducer(INITIAL_STATE, {
      type: "projects-loaded",
      projects: [project, other],
      activeProjectId: project.id,
    });
    state = desktopReducer(state, { type: "project-threads-loaded", projectId: project.id, threads: [thread] });
    state = desktopReducer(state, {
      type: "project-threads-loaded",
      projectId: other.id,
      threads: [{ ...thread, id: "other-thread", projectId: other.id }],
    });

    state = desktopReducer(state, { type: "project-removed", projectId: project.id });

    expect(state.projects).toEqual([other]);
    expect(state.activeProjectId).toBeNull();
    expect(state.threadCatalogs[project.id]).toBeUndefined();
    expect(state.threadCatalogs[other.id]).toHaveLength(1);
  });
});

function createBootstrap(): SessionBootstrap {
  return {
    protocolVersion: PROTOCOL_VERSION,
    projectId: project.id,
    threadId: thread.id,
    timeline: {
      protocolVersion: PROTOCOL_VERSION,
      projectId: project.id,
      threadId: thread.id,
      cursor: 0,
      headId: null,
      nodes: [],
      queue: [],
      phase: "idle",
    },
    control: {
      protocolVersion: PROTOCOL_VERSION,
      revision: 0,
      projectId: project.id,
      threadId: thread.id,
      title: thread.title,
      updatedAt: thread.updatedAt,
      cwd: project.cwd,
      running: false,
      queueModes: { steering: "all", followUp: "all" },
      models: [],
      commands: [],
      thinkingLevel: "off",
      thinkingLevels: ["off"],
      readiness: { state: "ready" },
      hostRequests: [],
      extensionSet: { generation: "extensions-generation", diagnostics: [], reloadRequired: false },
      extensionHost: { statuses: {}, widgets: [] },
    },
  };
}
