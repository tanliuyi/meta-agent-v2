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

  it("materialized session 按 bootstrap 添加并去重", () => {
    let state = desktopReducer(INITIAL_STATE, { type: "thread-catalog-added", bootstrap: createBootstrap() });
    state = desktopReducer(state, { type: "thread-catalog-added", bootstrap: createBootstrap() });

    expect(state.threadCatalogs[project.id]).toHaveLength(1);
    expect(state.threadCatalogs[project.id]?.[0]).toMatchObject({ id: thread.id, title: "新会话" });
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
      extensionUi: { statuses: {}, workingVisible: false, editorRevision: 0, toolsExpanded: false, widgets: [] },
    },
  };
}
