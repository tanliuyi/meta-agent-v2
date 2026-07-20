import { createElement, type RefObject } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  DesktopThreadActions,
  PreparedDraftSubmission,
  PreparedThread,
} from "../src/renderer/src/runtime/use-pi-runtime.ts";
import type { DesktopActions } from "../src/renderer/src/state/desktop-actions.ts";
import { INITIAL_STATE } from "../src/renderer/src/state/desktop-model.ts";
import { createDesktopStore } from "../src/renderer/src/state/desktop-store.ts";
import { shouldRestoreActiveThread, useDesktopController } from "../src/renderer/src/state/use-desktop-controller.ts";
import type { DraftSessionConfig, Project, SessionBootstrap, Thread } from "../src/shared/contracts.ts";
import { PROTOCOL_VERSION } from "../src/shared/contracts.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useDesktopController navigation", () => {
  it("只恢复窗口内存中的 active thread，冷启动不恢复", () => {
    const targetProject = project("project");
    const store = createDesktopStore();

    expect(shouldRestoreActiveThread(store.getState(), targetProject.id)).toBe(false);

    store.setState((state) => ({
      ...state,
      activeThreadIds: { [targetProject.id]: "active-thread" },
    }));

    expect(shouldRestoreActiveThread(store.getState(), targetProject.id)).toBe(true);
    expect(shouldRestoreActiveThread(store.getState(), "other-project")).toBe(false);
  });

  it("取消 Project 选择不会使进行中的 thread load 失效", async () => {
    const currentProject = project("current");
    const currentThread = thread(currentProject, "current-thread");
    const runtimeOpen = deferred<PreparedThread>();
    const chooseProject = vi.fn(async () => null);
    vi.stubGlobal("window", { desktop: { projects: { choose: chooseProject } } });

    const store = createDesktopStore();
    store.setState(
      {
        ...INITIAL_STATE,
        projects: [currentProject],
        project: currentProject,
        threadCatalogs: { [currentProject.id]: [currentThread] },
        loading: false,
      },
      true,
    );
    const commitRuntime = vi.fn();
    const runtimeActions: DesktopThreadActions = {
      open: vi.fn(() => runtimeOpen.promise),
      commit: commitRuntime,
      enterDraft: async () => undefined,
      submitDraft: async () => {
        throw new Error("not used");
      },
      discardDraft: async () => null,
      rename: async () => undefined,
      archive: async () => undefined,
      remove: async () => undefined,
      clearQueue: async () => undefined,
      detach: async () => undefined,
    };
    const reference: RefObject<DesktopThreadActions | null> = { current: runtimeActions };
    let controller: DesktopActions | undefined;

    function Harness() {
      controller = useDesktopController(store, reference);
      return null;
    }

    renderToStaticMarkup(createElement(Harness));
    if (!controller) throw new Error("controller missing");
    const loading = controller.openThread(currentProject.id, currentThread.id);
    await Promise.resolve();
    await controller.chooseProject();

    expect(chooseProject).toHaveBeenCalledOnce();
    expect(store.getState()).toMatchObject({
      loading: true,
      pendingThreadLoad: { projectId: currentProject.id, threadId: currentThread.id },
    });

    const opened = prepared(currentProject, currentThread.id);
    runtimeOpen.resolve(opened);
    await loading;

    expect(commitRuntime).toHaveBeenCalledWith(opened);
    expect(store.getState()).toMatchObject({
      project: currentProject,
      loading: false,
      pendingThreadLoad: null,
    });
  });

  it("跨 Project 快速切换只允许最新 intent 进入 runtime 并最终持久化", async () => {
    const firstProject = project("first");
    const secondProject = project("second");
    const firstThread = thread(firstProject, "first-thread");
    const secondThread = thread(secondProject, "second-thread");
    const firstOpen = deferred<Project>();
    const openProject = vi.fn((projectId: string) =>
      projectId === firstProject.id ? firstOpen.promise : Promise.resolve(secondProject),
    );
    vi.stubGlobal("window", { desktop: { projects: { open: openProject } } });

    const store = createDesktopStore();
    store.setState(
      {
        ...INITIAL_STATE,
        projects: [firstProject, secondProject],
        threadCatalogs: {
          [firstProject.id]: [firstThread],
          [secondProject.id]: [secondThread],
        },
        loading: false,
      },
      true,
    );
    const openRuntime = vi.fn(async (targetProject: Project, threadId: string) => prepared(targetProject, threadId));
    const commitRuntime = vi.fn();
    const runtimeActions: DesktopThreadActions = {
      open: openRuntime,
      commit: commitRuntime,
      enterDraft: async () => undefined,
      submitDraft: async () => {
        throw new Error("not used");
      },
      discardDraft: async () => null,
      rename: async () => undefined,
      archive: async () => undefined,
      remove: async () => undefined,
      clearQueue: async () => undefined,
      detach: async () => undefined,
    };
    const reference: RefObject<DesktopThreadActions | null> = { current: runtimeActions };
    let controller: DesktopActions | undefined;

    function Harness() {
      controller = useDesktopController(store, reference);
      return null;
    }

    renderToStaticMarkup(createElement(Harness));
    if (!controller) throw new Error("controller missing");
    const stale = controller.openThread(firstProject.id, firstThread.id);
    await Promise.resolve();
    const latest = controller.openThread(secondProject.id, secondThread.id);

    expect(openProject).toHaveBeenCalledTimes(1);
    firstOpen.resolve(firstProject);
    await Promise.all([stale, latest]);

    expect(openProject).toHaveBeenNthCalledWith(1, firstProject.id);
    expect(openProject).toHaveBeenNthCalledWith(2, secondProject.id);
    expect(openRuntime).toHaveBeenCalledOnce();
    expect(openRuntime).toHaveBeenCalledWith(secondProject, secondThread.id);
    expect(commitRuntime).toHaveBeenCalledOnce();
    expect(store.getState().project).toBe(secondProject);
    expect(store.getState().activeThreadIds[secondProject.id]).toBe(secondThread.id);
  });

  it("首次提交附件准备期间保持 materializing 并阻止 thread 切换", async () => {
    const targetProject = project("draft-project");
    const targetThread = thread(targetProject, "target-thread");
    const submission = deferred<PreparedDraftSubmission>();
    const openRuntime = vi.fn(async (openedProject: Project, threadId: string) => prepared(openedProject, threadId));
    const runtimeActions = createRuntimeActions({
      open: openRuntime,
      submitDraft: () => submission.promise,
    });
    const store = createDesktopStore();
    store.setState(
      {
        ...INITIAL_STATE,
        projects: [targetProject],
        project: targetProject,
        draft: {
          projectId: targetProject.id,
          config: draftConfig(),
          configLoading: false,
          phase: "editing",
        },
        threadCatalogs: { [targetProject.id]: [targetThread] },
        loading: false,
      },
      true,
    );
    const controller = renderController(store, runtimeActions);

    const submitting = controller.submitDraft();
    await Promise.resolve();
    await controller.openThread(targetProject.id, targetThread.id);

    expect(openRuntime).not.toHaveBeenCalled();
    expect(store.getState().pendingThreadLoad).toBeNull();
    expect(store.getState().draft?.phase).toBe("materializing");
    submission.resolve({ ...prepared(targetProject, "created-thread"), sent: true });
    await submitting;

    expect(store.getState().draft).toBeNull();
    expect(store.getState().activeThreadIds[targetProject.id]).toBe("created-thread");
  });

  it("session attachment prepare 期间忽略第二次 openThread", async () => {
    const targetProject = project("project");
    const firstThread = thread(targetProject, "first-thread");
    const secondThread = thread(targetProject, "second-thread");
    const firstAttachment = deferred<PreparedThread>();
    const openRuntime = vi.fn(() => firstAttachment.promise);
    const commitRuntime = vi.fn();
    const store = createDesktopStore();
    store.setState(
      {
        ...INITIAL_STATE,
        projects: [targetProject],
        project: targetProject,
        threadCatalogs: { [targetProject.id]: [firstThread, secondThread] },
        loading: false,
      },
      true,
    );
    const controller = renderController(store, createRuntimeActions({ open: openRuntime, commit: commitRuntime }));

    const opening = controller.openThread(targetProject.id, firstThread.id);
    await Promise.resolve();
    await controller.openThread(targetProject.id, secondThread.id);

    expect(openRuntime).toHaveBeenCalledOnce();
    expect(openRuntime).toHaveBeenCalledWith(targetProject, firstThread.id);
    expect(store.getState().pendingThreadLoad).toEqual({
      projectId: targetProject.id,
      threadId: firstThread.id,
    });

    const opened = prepared(targetProject, firstThread.id);
    firstAttachment.resolve(opened);
    await opening;

    expect(commitRuntime).toHaveBeenCalledWith(opened);
    expect(store.getState().activeThreadIds[targetProject.id]).toBe(firstThread.id);
  });

  it("归档 baseline 后丢弃草稿不会恢复 archived thread", async () => {
    const targetProject = project("project");
    const archivedBaseline = { ...thread(targetProject, "baseline"), archived: true };
    const nextThread = thread(targetProject, "next-thread");
    const openRuntime = vi.fn(async (openedProject: Project, threadId: string) => prepared(openedProject, threadId));
    const commitRuntime = vi.fn();
    const runtimeActions = createRuntimeActions({
      open: openRuntime,
      commit: commitRuntime,
      discardDraft: async () => null,
    });
    const store = createDesktopStore();
    store.setState(
      {
        ...INITIAL_STATE,
        projects: [targetProject],
        project: targetProject,
        draft: { projectId: targetProject.id, config: draftConfig(), configLoading: false, phase: "editing" },
        threadCatalogs: { [targetProject.id]: [archivedBaseline, nextThread] },
        activeThreadIds: { [targetProject.id]: archivedBaseline.id },
        loading: false,
      },
      true,
    );
    const controller = renderController(store, runtimeActions);

    await controller.discardDraft();

    expect(openRuntime).not.toHaveBeenCalledWith(targetProject, archivedBaseline.id);
    expect(openRuntime).toHaveBeenCalledWith(targetProject, nextThread.id);
    expect(commitRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ bootstrap: expect.objectContaining({ threadId: nextThread.id }) }),
    );
    expect(store.getState().draft).toBeNull();
    expect(store.getState().activeThreadIds[targetProject.id]).toBe(nextThread.id);
  });

  it("归档完成后待切换 thread attach 失败会清理 archived active baseline", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const targetProject = project("project");
    const activeThread = thread(targetProject, "active-thread");
    const failedThread = thread(targetProject, "failed-thread");
    const nextThread = thread(targetProject, "next-thread");
    const failedAttachment = deferred<PreparedThread>();
    const openRuntime = vi.fn((openedProject: Project, threadId: string) =>
      threadId === failedThread.id ? failedAttachment.promise : Promise.resolve(prepared(openedProject, threadId)),
    );
    const commitRuntime = vi.fn();
    const archiveRuntime = vi.fn(async () => undefined);
    const store = createDesktopStore();
    store.setState(
      {
        ...INITIAL_STATE,
        projects: [targetProject],
        project: targetProject,
        threadCatalogs: { [targetProject.id]: [activeThread, failedThread, nextThread] },
        activeThreadIds: { [targetProject.id]: activeThread.id },
        bootstrap: prepared(targetProject, activeThread.id).bootstrap,
        loading: false,
      },
      true,
    );
    const controller = renderController(
      store,
      createRuntimeActions({ open: openRuntime, commit: commitRuntime, archive: archiveRuntime }),
    );

    const opening = controller.openThread(targetProject.id, failedThread.id);
    await vi.waitFor(() => {
      expect(openRuntime).toHaveBeenCalledWith(targetProject, failedThread.id);
      expect(store.getState().pendingThreadLoad).toEqual({
        projectId: targetProject.id,
        threadId: failedThread.id,
      });
    });
    await controller.setThreadArchived(targetProject.id, activeThread.id, true);
    failedAttachment.reject(new Error("attach failed"));
    await opening;

    expect(openRuntime).toHaveBeenCalledWith(targetProject, nextThread.id);
    expect(commitRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ bootstrap: expect.objectContaining({ threadId: nextThread.id }) }),
    );
    expect(store.getState().threadCatalogs[targetProject.id]?.find(({ id }) => id === activeThread.id)?.archived).toBe(
      true,
    );
    expect(store.getState().activeThreadIds[targetProject.id]).toBe(nextThread.id);
  });

  it("删除 active thread 后下一条 attach 失败会保持显式 empty 状态", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const targetProject = project("project");
    const activeThread = thread(targetProject, "active-thread");
    const nextThread = thread(targetProject, "next-thread");
    const activePrepared = prepared(targetProject, activeThread.id);
    const detachRuntime = vi.fn(async () => undefined);
    const openRuntime = vi.fn(async () => {
      throw new Error("attach failed");
    });
    const store = createDesktopStore();
    store.setState(
      {
        ...INITIAL_STATE,
        projects: [targetProject],
        project: targetProject,
        threadCatalogs: { [targetProject.id]: [activeThread, nextThread] },
        activeThreadIds: { [targetProject.id]: activeThread.id },
        bootstrap: activePrepared.bootstrap,
        workbenches: { [`${targetProject.id}:${activeThread.id}`]: activePrepared.workbench },
        loading: false,
      },
      true,
    );
    const controller = renderController(store, createRuntimeActions({ open: openRuntime, detach: detachRuntime }));

    await controller.removeThread(targetProject.id, activeThread.id);

    expect(openRuntime).toHaveBeenCalledWith(targetProject, nextThread.id);
    expect(detachRuntime).toHaveBeenCalledOnce();
    expect(store.getState()).toMatchObject({
      bootstrap: null,
      pendingThreadLoad: null,
      loading: false,
      error: "attach failed",
    });
    expect(store.getState().activeThreadIds[targetProject.id]).toBeUndefined();
  });

  it("删除 committed Project 不丢失另一 Project 的 draft config response", async () => {
    const committedProject = project("committed");
    const draftProject = project("draft");
    const configResponse = deferred<DraftSessionConfig>();
    vi.stubGlobal("window", {
      desktop: {
        projects: { remove: vi.fn(async () => undefined) },
        sessions: { getDraftConfig: vi.fn(() => configResponse.promise) },
      },
    });
    const store = createDesktopStore();
    store.setState(
      {
        ...INITIAL_STATE,
        projects: [committedProject, draftProject],
        project: committedProject,
        draft: { projectId: draftProject.id, config: null, configLoading: false, phase: "editing" },
        loading: false,
      },
      true,
    );
    const detachRuntime = vi.fn(async () => undefined);
    const controller = renderController(store, createRuntimeActions({ detach: detachRuntime }));

    const loadingConfig = controller.selectDraftProject(draftProject.id);
    await Promise.resolve();
    await controller.removeProject(committedProject.id);
    const config = draftConfig();
    configResponse.resolve(config);
    await loadingConfig;

    expect(detachRuntime).toHaveBeenCalledOnce();
    expect(store.getState().project).toBeNull();
    expect(store.getState().draft).toEqual({
      projectId: draftProject.id,
      config,
      configLoading: false,
      phase: "editing",
    });
  });

  it("删除期间拒绝 stale catalog，并允许同 ID Project 重加后 fresh load", async () => {
    const targetProject = project("project");
    const staleThread = thread(targetProject, "stale-thread");
    const freshThread = thread(targetProject, "fresh-thread");
    const staleCatalog = deferred<Thread[]>();
    const freshCatalog = deferred<Thread[]>();
    const removal = deferred<void>();
    let listCalls = 0;
    const listThreads = vi.fn((_projectId: string, _includeArchived: boolean) => {
      listCalls += 1;
      return listCalls === 1 ? staleCatalog.promise : freshCatalog.promise;
    });
    vi.stubGlobal("window", {
      desktop: {
        projects: { remove: vi.fn(() => removal.promise) },
        sessions: { list: listThreads },
      },
    });
    const store = createDesktopStore();
    store.setState({ ...INITIAL_STATE, projects: [targetProject], loading: false }, true);
    const controller = renderController(store, createRuntimeActions());

    const staleLoad = controller.loadProjectThreads(targetProject.id);
    const removing = controller.removeProject(targetProject.id);
    staleCatalog.resolve([staleThread]);
    await staleLoad;

    expect(Object.hasOwn(store.getState().threadCatalogs, targetProject.id)).toBe(false);

    removal.resolve(undefined);
    await removing;
    store.setState((state) => ({ ...state, projects: [targetProject] }), true);
    const freshLoad = controller.loadProjectThreads(targetProject.id);
    freshCatalog.resolve([freshThread]);
    await freshLoad;

    expect(listThreads).toHaveBeenCalledTimes(2);
    expect(store.getState().threadCatalogs[targetProject.id]).toEqual([freshThread]);
  });
});

function renderController(
  store: ReturnType<typeof createDesktopStore>,
  runtimeActions: DesktopThreadActions,
): DesktopActions {
  const reference: RefObject<DesktopThreadActions | null> = { current: runtimeActions };
  let controller: DesktopActions | undefined;

  function Harness() {
    controller = useDesktopController(store, reference);
    return null;
  }

  renderToStaticMarkup(createElement(Harness));
  if (!controller) throw new Error("controller missing");
  return controller;
}

function createRuntimeActions(overrides: Partial<DesktopThreadActions> = {}): DesktopThreadActions {
  return {
    open: async (targetProject, threadId) => prepared(targetProject, threadId),
    commit: () => undefined,
    enterDraft: async () => undefined,
    submitDraft: async () => {
      throw new Error("not used");
    },
    discardDraft: async () => null,
    rename: async () => undefined,
    archive: async () => undefined,
    remove: async () => undefined,
    clearQueue: async () => undefined,
    detach: async () => undefined,
    ...overrides,
  };
}

function project(id: string): Project {
  return { id, name: id, cwd: `/tmp/${id}`, lastOpenedAt: 1, available: true };
}

function thread(targetProject: Project, id: string): Thread {
  return {
    id,
    projectId: targetProject.id,
    title: id,
    createdAt: 1,
    updatedAt: 1,
    messageCount: 0,
    preview: "",
    archived: false,
    running: false,
  };
}

function prepared(targetProject: Project, threadId: string): PreparedThread {
  const bootstrap = bootstrapFor(targetProject.id, threadId);
  return {
    bootstrap,
    workbench: {
      projectId: targetProject.id,
      threadId,
      panel: "chat",
      panelOpen: false,
      panelWidth: 420,
      terminalOpen: false,
      terminalHeight: 240,
      openFiles: [],
      expandedPaths: [],
    },
  };
}

function draftConfig(): DraftSessionConfig {
  return {
    models: [
      {
        provider: "provider",
        id: "model",
        name: "Model",
        contextWindow: 128_000,
        thinking: true,
        thinkingLevels: ["off", "medium"],
      },
    ],
    commands: [],
    model: { provider: "provider", id: "model", name: "Model" },
    thinkingLevel: "medium",
    thinkingLevels: ["off", "medium"],
    readiness: { state: "ready" },
  };
}

function bootstrapFor(projectId: string, threadId: string): SessionBootstrap {
  return {
    protocolVersion: PROTOCOL_VERSION,
    projectId,
    threadId,
    timeline: {
      protocolVersion: PROTOCOL_VERSION,
      projectId,
      threadId,
      cursor: 0,
      headId: null,
      nodes: [],
      queue: [],
      phase: "idle",
    },
    control: {
      protocolVersion: PROTOCOL_VERSION,
      revision: 0,
      projectId,
      threadId,
      title: threadId,
      updatedAt: 1,
      cwd: `/tmp/${projectId}`,
      running: false,
      queueModes: { steering: "one-at-a-time", followUp: "one-at-a-time" },
      models: [],
      commands: [],
      thinkingLevel: "off",
      thinkingLevels: ["off"],
      readiness: { state: "ready" },
      hostRequests: [],
      extensionUi: { statuses: {}, workingVisible: true, editorRevision: 0, toolsExpanded: false, widgets: [] },
    },
  };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(value: unknown): void } {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve(value) {
      resolvePromise?.(value);
    },
    reject(value) {
      rejectPromise?.(value);
    },
  };
}
