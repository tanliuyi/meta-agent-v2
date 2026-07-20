import { type RefObject, startTransition, useCallback, useEffect, useMemo, useRef } from "react";
import { unstable_batchedUpdates } from "react-dom";
import type { Project, ThinkingLevel, WorkbenchState } from "../../../shared/contracts.ts";
import { runDraftSubmissionSingleFlight } from "../runtime/draft-session.ts";
import { piSessionBus } from "../runtime/pi-session-bus.ts";
import type { DesktopThreadActions } from "../runtime/use-pi-runtime.ts";
import { errorMessage } from "../shared/lib/error-message.ts";
import type { DesktopActions } from "./desktop-actions.ts";
import { type DesktopState, desktopSessionKey, threadFromBootstrap } from "./desktop-model.ts";
import { selectActiveThreadId } from "./desktop-selectors.ts";
import { type DesktopStore, dispatchDesktop } from "./desktop-store.ts";
import { nextRegularThreadId } from "./thread-list-commands.ts";

/**
 * 组合 Desktop IPC、权威快照和本地 Workbench cache。
 *
 * 所有命令都在调用时读取 store，避免命令引用随状态变化并迫使视图订阅整棵状态树。
 */
export function useDesktopController(
  store: DesktopStore,
  threadActions: RefObject<DesktopThreadActions | null>,
): DesktopActions {
  const dispatch = useCallback(
    (action: Parameters<typeof dispatchDesktop>[1]) => dispatchDesktop(store, action),
    [store],
  );
  const pendingThreadCatalogs = useRef(new Map<string, Promise<void>>());
  const pendingThreadAttachment = useRef<Promise<void> | null>(null);
  const pendingDraftSubmission = useRef<Promise<void> | null>(null);
  const pendingDraftProjectSelection = useRef<Promise<void> | null>(null);
  const draftProjectGeneration = useRef(0);
  const threadCatalogGenerations = useRef(new Map<string, number>());
  const navigationGeneration = useRef(0);
  const projectOpenTail = useRef<Promise<void>>(Promise.resolve());

  const beginNavigation = useCallback(() => {
    navigationGeneration.current += 1;
    return navigationGeneration.current;
  }, []);

  const isCurrentNavigation = useCallback((generation: number) => navigationGeneration.current === generation, []);

  /** 串行 ProjectStore.open，确保 main 持久化的 active Project 也遵循用户意图顺序。 */
  const openProjectForNavigation = useCallback(
    (projectId: string, generation: number): Promise<Project> => {
      const task = projectOpenTail.current.then(async () => {
        if (!isCurrentNavigation(generation)) throw new DOMException("Navigation superseded", "AbortError");
        const project = await window.desktop.projects.open(projectId);
        if (!isCurrentNavigation(generation)) throw new DOMException("Navigation superseded", "AbortError");
        return project;
      });
      projectOpenTail.current = task.then(
        () => undefined,
        () => undefined,
      );
      return task;
    },
    [isCurrentNavigation],
  );

  const report = useCallback(
    (value: unknown) => {
      const message = errorMessage(value);
      console.error("Desktop operation failed", value);
      dispatch({ type: "error", error: message });
    },
    [dispatch],
  );

  const loadDraftConfiguration = useCallback(
    async (projectId: string, generation: number) => {
      const task = window.desktop.sessions.getDraftConfig(projectId);
      const pending = task.then(
        () => undefined,
        () => undefined,
      );
      pendingDraftProjectSelection.current = pending;
      try {
        const config = await task;
        if (generation !== draftProjectGeneration.current) return;
        dispatch({ type: "draft-config-loaded", projectId, config });
      } catch (value) {
        if (generation !== draftProjectGeneration.current) return;
        dispatch({ type: "draft-config-failed", projectId });
        throw value;
      } finally {
        if (pendingDraftProjectSelection.current === pending) pendingDraftProjectSelection.current = null;
      }
    },
    [dispatch],
  );

  const loadThread = useCallback(
    async (project: Project, threadId: string, navigation: number, optimistic = true) => {
      if (!isCurrentNavigation(navigation)) return false;
      if (optimistic) dispatch({ type: "thread-load-started", project, threadId });
      try {
        const actions = threadActions.current;
        if (!actions) throw new Error("assistant-ui thread adapter 尚未就绪");
        const task = actions.open(project, threadId);
        const pending = task.then(
          () => undefined,
          () => undefined,
        );
        pendingThreadAttachment.current = pending;
        const prepared = await task.finally(() => {
          if (pendingThreadAttachment.current === pending) pendingThreadAttachment.current = null;
        });
        if (!isCurrentNavigation(navigation)) return false;
        unstable_batchedUpdates(() => {
          actions.commit(prepared);
          dispatch({ type: "thread-loaded", project, bootstrap: prepared.bootstrap, workbench: prepared.workbench });
        });
        return true;
      } catch (value) {
        if (!isCurrentNavigation(navigation)) return false;
        dispatch({ type: "thread-load-failed", projectId: project.id, threadId });
        if (value instanceof DOMException && value.name === "AbortError") return false;
        report(value);
        return false;
      }
    },
    [dispatch, isCurrentNavigation, report, threadActions],
  );

  const recoverArchivedActiveThread = useCallback(
    async (projectId: string, excludedThreadId?: string) => {
      const state = store.getState();
      if (state.draft || state.pendingThreadLoad || state.project?.id !== projectId) return;
      const activeThreadId = state.activeThreadIds[projectId];
      if (!activeThreadId) return;
      const activeThread = state.threadCatalogs[projectId]?.find(({ id }) => id === activeThreadId);
      if (!activeThread?.archived) return;
      const project = state.projects.find(({ id }) => id === projectId);
      if (!project) return;

      const navigation = beginNavigation();
      const candidates = excludedThreadId
        ? (state.threadCatalogs[projectId] ?? []).filter(({ id }) => id !== excludedThreadId)
        : (state.threadCatalogs[projectId] ?? []);
      const nextThreadId = nextRegularThreadId(candidates, activeThreadId);
      if (nextThreadId && (await loadThread(project, nextThreadId, navigation))) return;
      if (!isCurrentNavigation(navigation)) return;
      const actions = threadActions.current;
      if (!actions) throw new Error("assistant-ui thread adapter 尚未就绪");
      await actions.detach();
      if (!isCurrentNavigation(navigation)) return;
      dispatch({ type: "thread-cleared", projectId });
    },
    [beginNavigation, dispatch, isCurrentNavigation, loadThread, store, threadActions],
  );

  const loadProject = useCallback(
    async (project: Project, navigation: number, openExistingThread = true) => {
      const threads = await window.desktop.sessions.list(project.id, true);
      if (!isCurrentNavigation(navigation)) return;
      dispatch({ type: "project-loaded", project, threads });
      const preferredThreadId = store.getState().activeThreadIds[project.id];
      const target = openExistingThread
        ? (threads.find(({ archived, id }) => !archived && id === preferredThreadId) ??
          threads.find(({ archived }) => !archived))
        : undefined;
      if (target) await loadThread(project, target.id, navigation);
      else {
        const actions = threadActions.current;
        if (!actions) throw new Error("assistant-ui thread adapter 尚未就绪");
        await actions.enterDraft();
        if (!isCurrentNavigation(navigation)) return;
        const generation = ++draftProjectGeneration.current;
        dispatch({ type: "draft-started", projectId: project.id });
        await loadDraftConfiguration(project.id, generation);
      }
    },
    [dispatch, isCurrentNavigation, loadDraftConfiguration, loadThread, store, threadActions],
  );

  const loadProjectThreads = useCallback(
    (projectId: string) => {
      const state = store.getState();
      if (!state.projects.some(({ id }) => id === projectId)) return Promise.resolve();
      if (Object.hasOwn(state.threadCatalogs, projectId)) return Promise.resolve();
      const pending = pendingThreadCatalogs.current.get(projectId);
      if (pending) return pending;
      const generation = (threadCatalogGenerations.current.get(projectId) ?? 0) + 1;
      threadCatalogGenerations.current.set(projectId, generation);
      const promise = window.desktop.sessions
        .list(projectId, true)
        .then((threads) => {
          if (
            threadCatalogGenerations.current.get(projectId) !== generation ||
            !store.getState().projects.some(({ id }) => id === projectId)
          )
            return;
          startTransition(() => {
            dispatch({ type: "project-threads-loaded", projectId, threads });
          });
        })
        .catch((value: unknown) => {
          if (
            threadCatalogGenerations.current.get(projectId) === generation &&
            store.getState().projects.some(({ id }) => id === projectId)
          )
            report(value);
        })
        .finally(() => {
          if (threadCatalogGenerations.current.get(projectId) === generation)
            pendingThreadCatalogs.current.delete(projectId);
        });
      pendingThreadCatalogs.current.set(projectId, promise);
      return promise;
    },
    [dispatch, report, store],
  );

  useEffect(() => {
    let active = true;
    const navigation = beginNavigation();
    void Promise.all([window.desktop.projects.list(), window.desktop.projects.getActive()])
      .then(async ([projects, current]) => {
        if (!active || !isCurrentNavigation(navigation)) return;
        dispatch({ type: "projects-loaded", projects });
        if (current?.available) {
          await loadProject(current, navigation, shouldRestoreActiveThread(store.getState(), current.id));
        }
      })
      .catch((value: unknown) => {
        if (active && isCurrentNavigation(navigation)) report(value);
      })
      .finally(() => {
        if (active && isCurrentNavigation(navigation)) dispatch({ type: "loading", loading: false });
      });
    return () => {
      active = false;
      if (isCurrentNavigation(navigation)) navigationGeneration.current += 1;
    };
  }, [beginNavigation, dispatch, isCurrentNavigation, loadProject, report, store]);

  useEffect(() => piSessionBus.onControl((control) => dispatch({ type: "control", control })), [dispatch]);
  useEffect(
    () =>
      piSessionBus.onRuntime((availability) => {
        if (availability.state === "unavailable") {
          dispatch({
            type: "error",
            error: availability.unknownOutcome
              ? "The thread worker stopped. The last action may have completed; it was not replayed. Restoring from disk."
              : (availability.error ?? "The thread worker stopped. Restoring from disk."),
          });
        }
      }),
    [dispatch],
  );
  useEffect(
    () => () => {
      navigationGeneration.current += 1;
      void threadActions.current?.detach();
    },
    [threadActions],
  );

  const chooseProject = useCallback(async () => {
    if (store.getState().draft?.phase === "materializing" || pendingDraftProjectSelection.current) return;
    let navigation: number | undefined;
    try {
      const project = await window.desktop.projects.choose();
      if (!project) return;
      navigation = beginNavigation();
      dispatch({ type: "project-upserted", project });
      if (store.getState().draft) {
        const generation = ++draftProjectGeneration.current;
        dispatch({ type: "draft-project-selected", projectId: project.id });
        await loadDraftConfiguration(project.id, generation);
      } else await loadProject(project, navigation);
    } catch (value) {
      if (navigation === undefined || isCurrentNavigation(navigation)) report(value);
    }
  }, [beginNavigation, dispatch, isCurrentNavigation, loadDraftConfiguration, loadProject, report, store]);

  const removeProject = useCallback(
    async (projectId: string) => {
      const initial = store.getState();
      if (initial.draft?.phase === "materializing") return;
      const invalidateThreadCatalog = () => {
        threadCatalogGenerations.current.set(projectId, (threadCatalogGenerations.current.get(projectId) ?? 0) + 1);
        pendingThreadCatalogs.current.delete(projectId);
      };
      invalidateThreadCatalog();
      const initiallyAffectsNavigation =
        initial.project?.id === projectId ||
        initial.draft?.projectId === projectId ||
        initial.pendingThreadLoad?.projectId === projectId;
      let navigation = initiallyAffectsNavigation ? beginNavigation() : navigationGeneration.current;
      try {
        await window.desktop.projects.remove(projectId);
        invalidateThreadCatalog();
        const current = store.getState();
        const currentlyAffectsNavigation =
          current.project?.id === projectId ||
          current.draft?.projectId === projectId ||
          current.pendingThreadLoad?.projectId === projectId;
        if (!initiallyAffectsNavigation && currentlyAffectsNavigation) navigation = beginNavigation();
        if (current.draft?.projectId === projectId) draftProjectGeneration.current += 1;
        if (
          currentlyAffectsNavigation &&
          isCurrentNavigation(navigation) &&
          current.project?.id === projectId &&
          current.draft?.projectId !== projectId
        ) {
          await threadActions.current?.detach();
        }
        dispatch({ type: "project-removed", projectId });
      } catch (value) {
        report(value);
      }
    },
    [beginNavigation, dispatch, isCurrentNavigation, report, store, threadActions],
  );

  const beginDraft = useCallback(
    async (projectId?: string) => {
      const state = store.getState();
      if (state.draft || pendingDraftSubmission.current) return;
      const navigation = beginNavigation();
      try {
        const selected = projectId
          ? state.projects.find((project) => project.id === projectId && project.available)
          : ((state.project?.available ? state.project : undefined) ??
            state.projects.find(({ available }) => available));
        if (!selected) throw new Error("新建会话前必须先添加可用的 Project");
        const actions = threadActions.current;
        if (!actions) throw new Error("assistant-ui thread adapter 尚未就绪");
        await actions.enterDraft();
        if (!isCurrentNavigation(navigation)) return;
        const generation = ++draftProjectGeneration.current;
        dispatch({ type: "draft-started", projectId: selected.id });
        await loadDraftConfiguration(selected.id, generation);
      } catch (value) {
        if (isCurrentNavigation(navigation)) report(value);
      }
    },
    [beginNavigation, dispatch, isCurrentNavigation, loadDraftConfiguration, report, store, threadActions],
  );

  const selectDraftProject = useCallback(
    async (projectId: string) => {
      const state = store.getState();
      if (!state.draft || state.draft.phase === "materializing") return;
      const project = state.projects.find(({ id }) => id === projectId);
      if (!project?.available) throw new Error("发送前必须选择可用的 Project");
      const generation = ++draftProjectGeneration.current;
      dispatch({ type: "draft-project-selected", projectId });
      try {
        await loadDraftConfiguration(projectId, generation);
      } catch (value) {
        report(value);
        throw value;
      }
    },
    [dispatch, loadDraftConfiguration, report, store],
  );

  const selectDraftModel = useCallback(
    (provider: string, modelId: string) => {
      if (store.getState().draft?.phase !== "editing") return;
      dispatch({ type: "draft-model-selected", provider, modelId });
    },
    [dispatch, store],
  );

  const selectDraftThinking = useCallback(
    (thinkingLevel: ThinkingLevel) => {
      if (store.getState().draft?.phase !== "editing") return;
      dispatch({ type: "draft-thinking-selected", thinkingLevel });
    },
    [dispatch, store],
  );

  const submitDraft = useCallback(() => {
    return runDraftSubmissionSingleFlight(pendingDraftSubmission, async () => {
      if (pendingDraftProjectSelection.current) throw new Error("Project 切换完成后才能发送");
      const state = store.getState();
      const currentDraft = state.draft;
      const project = state.projects.find(({ id }) => id === currentDraft?.projectId);
      if (!currentDraft || !project?.available) throw new Error("发送前必须选择可用的 Project");
      const config = currentDraft.config;
      if (currentDraft.configLoading || !config) throw new Error("模型配置加载完成后才能发送");
      if (config.readiness.state !== "ready" || !config.model) {
        throw new Error(config.readiness.message ?? "发送前必须选择可用的模型");
      }
      const actions = threadActions.current;
      if (!actions) throw new Error("assistant-ui thread adapter 尚未就绪");
      dispatch({ type: "draft-materializing" });
      try {
        const prepared = await actions.submitDraft({
          project,
          model: { provider: config.model.provider, id: config.model.id },
          thinkingLevel: config.thinkingLevel,
        });
        dispatch({
          type: "draft-committed",
          project,
          thread: threadFromBootstrap(prepared.bootstrap),
          bootstrap: prepared.bootstrap,
          workbench: prepared.workbench,
        });
      } catch (value) {
        dispatch({ type: "draft-restored" });
        report(value);
        throw value;
      }
    });
  }, [dispatch, report, store, threadActions]);

  const discardDraft = useCallback(async () => {
    if (!store.getState().draft || pendingDraftSubmission.current) return;
    const navigation = beginNavigation();
    draftProjectGeneration.current += 1;
    const previousProjectId = store.getState().project?.id;
    const actions = threadActions.current;
    if (!actions) throw new Error("assistant-ui thread adapter 尚未就绪");
    const prepared = await actions.discardDraft();
    if (!isCurrentNavigation(navigation)) return;
    if (!prepared) {
      dispatch({ type: "draft-discarded" });
      if (previousProjectId) await recoverArchivedActiveThread(previousProjectId);
      return;
    }
    const project = store.getState().projects.find(({ id }) => id === prepared.bootstrap.projectId);
    if (!project) throw new Error(`恢复的 session 缺少 Project: ${prepared.bootstrap.projectId}`);
    const openedProject = await openProjectForNavigation(project.id, navigation);
    if (!isCurrentNavigation(navigation)) return;
    dispatch({
      type: "thread-loaded",
      project: openedProject,
      bootstrap: prepared.bootstrap,
      workbench: prepared.workbench,
    });
  }, [
    beginNavigation,
    dispatch,
    isCurrentNavigation,
    openProjectForNavigation,
    recoverArchivedActiveThread,
    store,
    threadActions,
  ]);

  const openThread = useCallback(
    async (projectId: string, threadId: string) => {
      const state = store.getState();
      if (state.draft?.phase === "materializing" || pendingDraftSubmission.current || pendingThreadAttachment.current)
        return;
      const targetProject = state.projects.find(({ id }) => id === projectId);
      if (!targetProject) return;
      const navigation = beginNavigation();
      dispatch({ type: "thread-load-started", project: targetProject, threadId });
      try {
        const leavingDraft = state.draft !== null;
        draftProjectGeneration.current += 1;
        const project =
          !leavingDraft && state.project?.id === projectId
            ? state.project
            : await openProjectForNavigation(projectId, navigation);
        if (!isCurrentNavigation(navigation)) return;
        const loaded = await loadThread(project, threadId, navigation, false);
        if (!loaded && isCurrentNavigation(navigation)) await recoverArchivedActiveThread(projectId, threadId);
      } catch (value) {
        if (!isCurrentNavigation(navigation)) return;
        dispatch({ type: "thread-load-failed", projectId, threadId });
        if (value instanceof DOMException && value.name === "AbortError") return;
        report(value);
      }
    },
    [
      beginNavigation,
      dispatch,
      isCurrentNavigation,
      loadThread,
      openProjectForNavigation,
      recoverArchivedActiveThread,
      report,
      store,
    ],
  );

  const renameThread = useCallback(
    async (projectId: string, threadId: string, title: string) => {
      const state = store.getState();
      const project = state.projects.find(({ id }) => id === projectId);
      if (!project) return;
      try {
        const actions = threadActions.current;
        if (!actions) throw new Error("assistant-ui thread adapter 尚未就绪");
        await actions.rename(project, threadId, title);
        dispatch({ type: "thread-renamed", projectId, threadId, title });
      } catch (value) {
        report(value);
      }
    },
    [dispatch, report, store, threadActions],
  );

  const setThreadArchived = useCallback(
    async (projectId: string, threadId: string, archived: boolean) => {
      const state = store.getState();
      const navigationAtStart = navigationGeneration.current;
      const project = state.projects.find(({ id }) => id === projectId);
      if (!project) return;
      try {
        const actions = threadActions.current;
        if (!actions) throw new Error("assistant-ui thread adapter 尚未就绪");
        await actions.archive(project, threadId, archived);
        dispatch({ type: "thread-archived", projectId, threadId, archived });
        if (archived && navigationGeneration.current === navigationAtStart) {
          await recoverArchivedActiveThread(projectId);
        }
      } catch (value) {
        report(value);
      }
    },
    [dispatch, recoverArchivedActiveThread, report, store, threadActions],
  );

  const removeThread = useCallback(
    async (projectId: string, threadId: string) => {
      const state = store.getState();
      const navigationAtStart = navigationGeneration.current;
      const project = state.projects.find(({ id }) => id === projectId);
      if (!project) return;
      const wasActive =
        state.draft === null && state.project?.id === projectId && state.activeThreadIds[projectId] === threadId;
      try {
        const actions = threadActions.current;
        if (!actions) throw new Error("assistant-ui thread adapter 尚未就绪");
        await actions.remove(project, threadId);
        dispatch({ type: "thread-removed", projectId, threadId });
        if (wasActive && navigationGeneration.current === navigationAtStart) {
          const navigation = beginNavigation();
          const current = store.getState();
          const nextThreadId = nextRegularThreadId(current.threadCatalogs[projectId] ?? [], threadId);
          if (nextThreadId && (await loadThread(project, nextThreadId, navigation))) return;
          if (!isCurrentNavigation(navigation)) return;
          dispatch({ type: "thread-cleared", projectId });
          await actions.detach();
        }
      } catch (value) {
        report(value);
      }
    },
    [beginNavigation, dispatch, isCurrentNavigation, loadThread, report, store, threadActions],
  );

  const updateWorkbench = useCallback(
    (value: Partial<WorkbenchState>) => {
      const state = store.getState();
      const activeThreadId = selectActiveThreadId(state);
      if (!state.project || !activeThreadId) return;
      const key = desktopSessionKey(state.project.id, activeThreadId);
      const previous = state.workbenches[key];
      if (!previous) return;
      const workbench = { ...previous, ...value };
      dispatch({ type: "workbench", workbench });
      void window.desktop.workbench.update(workbench).catch(report);
    },
    [dispatch, report, store],
  );

  const clearQueue = useCallback(async () => {
    const actions = threadActions.current;
    if (!actions) throw new Error("assistant-ui thread adapter 尚未就绪");
    try {
      await actions.clearQueue();
    } catch (value) {
      report(value);
      throw value;
    }
  }, [report, threadActions]);

  const compactSession = useCallback(async () => {
    const state = store.getState();
    const activeThreadId = selectActiveThreadId(state);
    if (!state.project || !activeThreadId) throw new Error("压缩前必须打开 Pi session");
    try {
      await window.desktop.sessions.compact(state.project.id, activeThreadId);
    } catch (value) {
      report(value);
      throw value;
    }
  }, [report, store]);

  return useMemo(
    () => ({
      chooseProject,
      loadProjectThreads,
      removeProject,
      beginDraft,
      selectDraftProject,
      selectDraftModel,
      selectDraftThinking,
      submitDraft,
      discardDraft,
      openThread,
      renameThread,
      setThreadArchived,
      removeThread,
      clearQueue,
      compactSession,
      updateWorkbench,
      clearError: () => dispatch({ type: "error", error: null }),
    }),
    [
      dispatch,
      chooseProject,
      loadProjectThreads,
      removeProject,
      beginDraft,
      selectDraftProject,
      selectDraftModel,
      selectDraftThinking,
      submitDraft,
      discardDraft,
      openThread,
      renameThread,
      setThreadArchived,
      removeThread,
      clearQueue,
      compactSession,
      updateWorkbench,
    ],
  );
}

/** 仅恢复当前 renderer 窗口内存中的 active thread；冷启动没有该状态。 */
export function shouldRestoreActiveThread(state: DesktopState, projectId: string): boolean {
  return state.activeThreadIds[projectId] !== undefined;
}
