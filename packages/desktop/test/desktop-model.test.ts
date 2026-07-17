import { describe, expect, it } from "vitest";
import {
  desktopReducer,
  INITIAL_STATE,
  selectActiveThreadId,
  selectNavigationProjectId,
  selectNavigationThreadId,
} from "../src/renderer/src/state/desktop-model.ts";
import type {
  DraftSessionConfig,
  Project,
  SessionBootstrap,
  SessionControlState,
  Thread,
  WorkbenchState,
} from "../src/shared/contracts.ts";
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

describe("desktop reducer", () => {
  it("Project 按添加顺序倒序展示，并在新增时置顶", () => {
    const older = { ...project, id: "older", name: "older" };
    const newer = { ...project, id: "newer", name: "newer" };
    let state = desktopReducer(INITIAL_STATE, { type: "projects-loaded", projects: [older, newer] });

    expect(state.projects.map(({ id }) => id)).toEqual(["newer", "older"]);

    const newest = { ...project, id: "newest", name: "newest" };
    state = desktopReducer(state, { type: "project-upserted", project: newest });
    expect(state.projects.map(({ id }) => id)).toEqual(["newest", "newer", "older"]);

    state = desktopReducer(state, {
      type: "project-upserted",
      project: { ...older, name: "older updated", lastOpenedAt: 99 },
    });
    expect(state.projects.map(({ id }) => id)).toEqual(["newest", "newer", "older"]);
    expect(state.projects[2]?.name).toBe("older updated");
  });

  it("只接受 revision 更新的 control state，不复制消息历史", () => {
    const workbench = createWorkbench();
    let state = desktopReducer(INITIAL_STATE, { type: "project-loaded", project, threads: [thread] });
    state = desktopReducer(state, {
      type: "thread-loaded",
      project,
      bootstrap: createBootstrap(1, "第一版"),
      workbench,
    });
    state = desktopReducer(state, { type: "control", control: createControl(3, "第三版") });
    state = desktopReducer(state, { type: "control", control: createControl(2, "过期版本") });

    expect(state.controls["project:thread"]?.title).toBe("第三版");
    expect(state.bootstrap?.messages).toEqual([]);
    expect(state.threadCatalogs[project.id]?.[0]?.title).toBe("第三版");
  });

  it("thread 加载开始时乐观切换 navigation，并在失败后恢复原选择", () => {
    const targetThread = { ...thread, id: "target-thread" };
    const currentBootstrap = createBootstrap(1, "当前会话");
    let state = desktopReducer(INITIAL_STATE, {
      type: "project-loaded",
      project,
      threads: [thread, targetThread],
    });
    state = desktopReducer(state, {
      type: "thread-loaded",
      project,
      bootstrap: currentBootstrap,
      workbench: createWorkbench(),
    });

    state = desktopReducer(state, { type: "thread-load-started", project, threadId: targetThread.id });

    expect(selectActiveThreadId(state)).toBe(thread.id);
    expect(selectNavigationThreadId(state)).toBe(targetThread.id);
    expect(state.loading).toBe(true);
    expect(state.bootstrap).toBe(currentBootstrap);

    state = desktopReducer(state, {
      type: "thread-load-failed",
      projectId: project.id,
      threadId: targetThread.id,
    });

    expect(selectActiveThreadId(state)).toBe(thread.id);
    expect(selectNavigationThreadId(state)).toBe(thread.id);
    expect(state.loading).toBe(false);
    expect(state.bootstrap).toBe(currentBootstrap);
  });

  it("跨 Project 切换时不提前改变 runtime 使用的 committed project/thread", () => {
    const otherProject = { ...project, id: "other-project", cwd: "C:/other" };
    const otherThread = { ...thread, id: "other-thread", projectId: otherProject.id };
    let state = desktopReducer(INITIAL_STATE, { type: "project-loaded", project, threads: [thread] });
    state = desktopReducer(state, {
      type: "thread-loaded",
      project,
      bootstrap: createBootstrap(1, "当前会话"),
      workbench: createWorkbench(),
    });
    state = desktopReducer(state, {
      type: "project-threads-loaded",
      projectId: otherProject.id,
      threads: [otherThread],
    });

    state = desktopReducer(state, {
      type: "thread-load-started",
      project: otherProject,
      threadId: otherThread.id,
    });

    expect(selectNavigationProjectId(state)).toBe(otherProject.id);
    expect(selectNavigationThreadId(state)).toBe(otherThread.id);
    expect(state.project).toBe(project);
    expect(selectActiveThreadId(state)).toBe(thread.id);
  });

  it("快速连续切换只允许最新请求回滚，并恢复切换前的 committed thread", () => {
    const firstTarget = { ...thread, id: "first-target" };
    const secondTarget = { ...thread, id: "second-target" };
    let state = desktopReducer(INITIAL_STATE, {
      type: "project-loaded",
      project,
      threads: [thread, firstTarget, secondTarget],
    });
    state = desktopReducer(state, {
      type: "thread-loaded",
      project,
      bootstrap: createBootstrap(1, "当前会话"),
      workbench: createWorkbench(),
    });

    state = desktopReducer(state, { type: "thread-load-started", project, threadId: firstTarget.id });
    state = desktopReducer(state, { type: "thread-load-started", project, threadId: secondTarget.id });
    state = desktopReducer(state, {
      type: "thread-load-failed",
      projectId: project.id,
      threadId: firstTarget.id,
    });

    expect(selectActiveThreadId(state)).toBe(thread.id);
    expect(selectNavigationThreadId(state)).toBe(secondTarget.id);
    expect(state.loading).toBe(true);

    state = desktopReducer(state, {
      type: "thread-load-failed",
      projectId: project.id,
      threadId: secondTarget.id,
    });

    expect(selectActiveThreadId(state)).toBe(thread.id);
    expect(selectNavigationThreadId(state)).toBe(thread.id);
    expect(state.loading).toBe(false);
  });

  it("切换期间先到达的 run_end control 不会被旧 bootstrap 丢弃", () => {
    const targetThread = { ...thread, id: "target-thread", running: true };
    let state = desktopReducer(INITIAL_STATE, {
      type: "project-loaded",
      project,
      threads: [thread, targetThread],
    });
    state = desktopReducer(state, {
      type: "thread-loaded",
      project,
      bootstrap: createBootstrap(1, "当前会话"),
      workbench: createWorkbench(),
    });
    state = desktopReducer(state, {
      type: "control",
      control: { ...createControl(2, "目标会话"), threadId: targetThread.id, running: false },
    });
    state = desktopReducer(state, {
      type: "thread-loaded",
      project,
      bootstrap: {
        ...createBootstrap(1, "目标会话", 0, targetThread.id),
        control: { ...createControl(1, "目标会话"), threadId: targetThread.id, running: true },
      },
      workbench: { ...createWorkbench(), threadId: targetThread.id },
    });

    expect(state.controls["project:target-thread"]?.revision).toBe(2);
    expect(state.threadCatalogs[project.id]?.find(({ id }) => id === targetThread.id)?.running).toBe(false);
  });

  it("draft commit 保留 materialize 期间先到达的 run_end control", () => {
    let state = desktopReducer(INITIAL_STATE, { type: "draft-started", projectId: project.id });
    state = desktopReducer(state, {
      type: "control",
      control: { ...createControl(2, "首条消息"), running: false },
    });
    const bootstrap = {
      ...createBootstrap(1, "首条消息"),
      control: { ...createControl(1, "首条消息"), running: true },
    };

    state = desktopReducer(state, {
      type: "draft-committed",
      project,
      thread: { ...thread, running: true },
      bootstrap,
      workbench: createWorkbench(),
    });

    expect(state.controls["project:thread"]?.revision).toBe(2);
    expect(state.threadCatalogs[project.id]?.[0]?.running).toBe(false);
  });

  it("归档状态与当前 session 选择相互独立", () => {
    let state = desktopReducer(INITIAL_STATE, { type: "project-loaded", project, threads: [thread] });
    state = desktopReducer(state, {
      type: "thread-loaded",
      project,
      bootstrap: createBootstrap(1, "会话"),
      workbench: createWorkbench(),
    });
    state = desktopReducer(state, {
      type: "thread-archived",
      projectId: project.id,
      threadId: thread.id,
      archived: true,
    });

    expect(state.activeThreadIds[project.id]).toBe(thread.id);
    expect(state.threadCatalogs[project.id]?.[0]?.archived).toBe(true);
    expect(
      desktopReducer(state, { type: "thread-cleared", projectId: project.id }).activeThreadIds[project.id],
    ).toBeUndefined();
  });

  it("刷新 Project catalog 时保留仍然有效的 active thread 和列表引用", () => {
    let state = desktopReducer(INITIAL_STATE, { type: "project-loaded", project, threads: [thread] });
    state = desktopReducer(state, {
      type: "thread-loaded",
      project,
      bootstrap: createBootstrap(1, "会话"),
      workbench: createWorkbench(),
    });
    const cachedThreads = state.threadCatalogs[project.id];

    state = desktopReducer(state, { type: "project-loaded", project, threads: [{ ...thread }] });

    expect(state.activeThreadIds[project.id]).toBe(thread.id);
    expect(state.threadCatalogs[project.id]).toBe(cachedThreads);
  });

  it("分别缓存每个 Project 的 threads 和 active thread", () => {
    const otherProject = { ...project, id: "other-project", cwd: "C:/other" };
    const otherThread = { ...thread, id: "other-thread", projectId: otherProject.id };
    let state = desktopReducer(INITIAL_STATE, { type: "project-loaded", project, threads: [thread] });
    state = desktopReducer(state, {
      type: "thread-loaded",
      project,
      bootstrap: createBootstrap(1, "会话"),
      workbench: createWorkbench(),
    });
    state = desktopReducer(state, { type: "project-loaded", project: otherProject, threads: [otherThread] });

    expect(state.threadCatalogs[project.id]).toEqual([thread]);
    expect(state.threadCatalogs[otherProject.id]).toEqual([otherThread]);
    expect(state.activeThreadIds[project.id]).toBe(thread.id);
  });

  it("只加载展开 Project 的 catalog，不切换当前 Project 或 thread", () => {
    const otherProject = { ...project, id: "other-project", cwd: "C:/other" };
    const otherThread = { ...thread, id: "other-thread", projectId: otherProject.id };
    let state = desktopReducer(INITIAL_STATE, { type: "project-loaded", project, threads: [thread] });
    state = desktopReducer(state, {
      type: "thread-loaded",
      project,
      bootstrap: createBootstrap(1, "会话"),
      workbench: createWorkbench(),
    });

    state = desktopReducer(state, {
      type: "project-threads-loaded",
      projectId: otherProject.id,
      threads: [otherThread],
    });

    expect(state.project).toEqual(project);
    expect(state.activeThreadIds[otherProject.id]).toBeUndefined();
    expect(state.threadCatalogs[otherProject.id]).toEqual([otherThread]);
  });

  it("进入 draft 时保留 committed selection，但对外不暴露 thread", () => {
    let state = desktopReducer(INITIAL_STATE, { type: "project-loaded", project, threads: [thread] });
    state = desktopReducer(state, {
      type: "thread-loaded",
      project,
      bootstrap: createBootstrap(1, "会话"),
      workbench: createWorkbench(),
    });
    const catalog = state.threadCatalogs[project.id];

    state = desktopReducer(state, { type: "draft-started", projectId: project.id });

    expect(state.draft).toEqual({ projectId: project.id, config: null, configLoading: true, phase: "editing" });
    expect(state.project).toEqual(project);
    expect(state.activeThreadIds[project.id]).toBe(thread.id);
    expect(state.threadCatalogs[project.id]).toBe(catalog);
    expect(selectActiveThreadId(state)).toBeNull();
  });

  it("draft Project 切换只更新目标，不改变 committed Project 或 catalog", () => {
    const otherProject = { ...project, id: "other-project", cwd: "C:/other" };
    let state = desktopReducer(INITIAL_STATE, { type: "project-loaded", project, threads: [thread] });
    state = desktopReducer(state, { type: "draft-started", projectId: project.id });

    state = desktopReducer(state, {
      type: "draft-project-selected",
      projectId: otherProject.id,
    });

    expect(state.project).toEqual(project);
    expect(state.draft).toEqual({
      projectId: otherProject.id,
      config: null,
      configLoading: true,
      phase: "editing",
    });
    expect(state.threadCatalogs[otherProject.id]).toBeUndefined();
    expect(state.activeThreadIds[otherProject.id]).toBeUndefined();
    expect(selectActiveThreadId(state)).toBeNull();
  });

  it("draft commit 原子增加真实 thread 并清除 draft", () => {
    let state = desktopReducer(INITIAL_STATE, { type: "draft-started", projectId: project.id });
    const bootstrap = createBootstrap(1, "首条消息");

    state = desktopReducer(state, {
      type: "draft-committed",
      project,
      thread,
      bootstrap,
      workbench: createWorkbench(),
    });

    expect(state.draft).toBeNull();
    expect(state.threadCatalogs[project.id]).toEqual([thread]);
    expect(state.activeThreadIds[project.id]).toBe(thread.id);
    expect(state.bootstrap).toBe(bootstrap);
    expect(selectActiveThreadId(state)).toBe(thread.id);
  });

  it("session 来回切换时只保留 active bootstrap", () => {
    const otherThread = { ...thread, id: "other-thread" };
    const firstBootstrap = createBootstrap(1, "第一个会话");
    const secondBootstrap = createBootstrap(1, "第二个会话", 0, otherThread.id);
    const returnedBootstrap = createBootstrap(2, "返回第一个会话");
    let state = desktopReducer(INITIAL_STATE, {
      type: "project-loaded",
      project,
      threads: [thread, otherThread],
    });
    state = desktopReducer(state, {
      type: "thread-loaded",
      project,
      bootstrap: firstBootstrap,
      workbench: createWorkbench(),
    });
    state = desktopReducer(state, {
      type: "thread-loaded",
      project,
      bootstrap: secondBootstrap,
      workbench: { ...createWorkbench(), threadId: otherThread.id },
    });
    state = desktopReducer(state, {
      type: "thread-loaded",
      project,
      bootstrap: returnedBootstrap,
      workbench: createWorkbench(),
    });

    expect(state.bootstrap).toBe(returnedBootstrap);
    expect(state.bootstrap).not.toBe(firstBootstrap);
    expect(state.bootstrap).not.toBe(secondBootstrap);
    expect(selectActiveThreadId(state)).toBe(thread.id);
  });

  it("control 未改变 thread 摘要时复用 catalog 引用", () => {
    let state = desktopReducer(INITIAL_STATE, { type: "project-loaded", project, threads: [thread] });
    state = desktopReducer(state, {
      type: "thread-loaded",
      project,
      bootstrap: createBootstrap(1, thread.title),
      workbench: createWorkbench(),
    });
    const catalogs = state.threadCatalogs;
    const projectThreads = state.threadCatalogs[project.id];

    state = desktopReducer(state, { type: "control", control: createControl(2, thread.title) });

    expect(state.threadCatalogs).toBe(catalogs);
    expect(state.threadCatalogs[project.id]).toBe(projectThreads);
    expect(state.controls["project:thread"]?.revision).toBe(2);
  });

  it("删除 draft Project 时保留草稿状态并清空目标", () => {
    let state = desktopReducer(INITIAL_STATE, { type: "draft-started", projectId: project.id });

    state = desktopReducer(state, { type: "project-removed", projectId: project.id });

    expect(state.project).toBeNull();
    expect(state.draft).toEqual({
      projectId: null,
      config: null,
      configLoading: false,
      phase: "editing",
    });
  });

  it("draft model 切换按目标模型能力 clamp thinking", () => {
    let state = desktopReducer(INITIAL_STATE, { type: "draft-started", projectId: project.id });
    state = desktopReducer(state, {
      type: "draft-config-loaded",
      projectId: project.id,
      config: createDraftConfig(),
    });
    state = desktopReducer(state, {
      type: "draft-thinking-selected",
      thinkingLevel: "high",
    });
    state = desktopReducer(state, {
      type: "draft-model-selected",
      provider: "plain",
      modelId: "plain-model",
    });

    expect(state.draft?.config).toMatchObject({
      model: { provider: "plain", id: "plain-model" },
      thinkingLevel: "off",
      thinkingLevels: ["off"],
      readiness: { state: "ready" },
    });
  });

  it("committed 空历史 thread 不会被推断为 draft", () => {
    let state = desktopReducer(INITIAL_STATE, { type: "project-loaded", project, threads: [thread] });
    state = desktopReducer(state, {
      type: "thread-loaded",
      project,
      bootstrap: createBootstrap(1, "空会话"),
      workbench: createWorkbench(),
    });

    expect(thread.messageCount).toBe(0);
    expect(state.draft).toBeNull();
    expect(selectActiveThreadId(state)).toBe(thread.id);
  });
});

function createWorkbench(): WorkbenchState {
  return {
    projectId: project.id,
    threadId: thread.id,
    panel: "files",
    panelOpen: true,
    panelWidth: 360,
    terminalOpen: false,
    terminalHeight: 280,
    openFiles: [],
    expandedPaths: [],
  };
}

function createBootstrap(revision: number, title: string, cursor = 0, threadId = thread.id): SessionBootstrap {
  return {
    protocolVersion: PROTOCOL_VERSION,
    projectId: project.id,
    threadId,
    cursor,
    control: { ...createControl(revision, title), threadId },
    messages: [],
    state: {},
  };
}

function createControl(revision: number, title: string): SessionControlState {
  return {
    protocolVersion: PROTOCOL_VERSION,
    revision,
    projectId: project.id,
    threadId: thread.id,
    title,
    cwd: project.cwd,
    running: false,
    compacting: false,
    queue: { steering: [], followUp: [] },
    models: [],
    commands: [],
    thinkingLevel: "off",
    thinkingLevels: ["off"],
    readiness: { state: "missing-model" },
    hostRequests: [],
    extensionUi: { statuses: {}, workingVisible: true, toolsExpanded: false, widgets: [] },
  };
}

function createDraftConfig(): DraftSessionConfig {
  return {
    models: [
      {
        provider: "reasoning",
        id: "reasoning-model",
        name: "Reasoning",
        contextWindow: 128_000,
        thinking: true,
        thinkingLevels: ["off", "low", "high"],
      },
      {
        provider: "plain",
        id: "plain-model",
        name: "Plain",
        contextWindow: 128_000,
        thinking: false,
        thinkingLevels: ["off"],
      },
    ],
    model: { provider: "reasoning", id: "reasoning-model", name: "Reasoning" },
    thinkingLevel: "low",
    thinkingLevels: ["off", "low", "high"],
    readiness: { state: "ready" },
  };
}
