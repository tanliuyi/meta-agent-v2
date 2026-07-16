import { type RefObject, useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import type { Project, ThinkingLevel, WorkbenchState } from "../../../shared/contracts.ts";
import { runDraftSubmissionSingleFlight } from "../runtime/draft-session.ts";
import { sessionEventBus } from "../runtime/session-event-bus.ts";
import type { DesktopThreadActions } from "../runtime/use-pi-runtime.ts";
import {
  type DesktopContextValue,
  desktopReducer,
  INITIAL_STATE,
  selectActiveThreadId,
  sessionKey,
  threadFromBootstrap,
} from "./desktop-model.ts";
import { nextRegularThreadId } from "./thread-list-commands.ts";

/** 组合 Desktop IPC、权威快照和本地 Workbench cache。 */
export function useDesktopController(threadActions: RefObject<DesktopThreadActions | null>): DesktopContextValue {
  const [state, dispatch] = useReducer(desktopReducer, INITIAL_STATE);
  const threads = state.project ? (state.threadCatalogs[state.project.id] ?? []) : [];
  const activeThreadId = selectActiveThreadId(state);
  const activeThreadIds = useRef(state.activeThreadIds);
  activeThreadIds.current = state.activeThreadIds;
  const draft = useRef(state.draft);
  draft.current = state.draft;
  const threadCatalogs = useRef(state.threadCatalogs);
  threadCatalogs.current = state.threadCatalogs;
  const pendingThreadCatalogs = useRef(new Map<string, Promise<void>>());
  const pendingDraftSubmission = useRef<Promise<void> | null>(null);
  const pendingDraftProjectSelection = useRef<Promise<void> | null>(null);
  const draftProjectGeneration = useRef(0);
  const activeProjectId = useRef(state.project?.id);
  activeProjectId.current = state.project?.id;

  const report = useCallback((value: unknown) => {
    dispatch({ type: "error", error: value instanceof Error ? value.message : String(value) });
  }, []);

  const loadDraftConfiguration = useCallback(async (projectId: string, generation: number) => {
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
  }, []);

  const loadThread = useCallback(
    async (project: Project, threadId: string) => {
      try {
        const actions = threadActions.current;
        if (!actions) throw new Error("assistant-ui thread adapter 尚未就绪");
        const prepared = await actions.open(project, threadId);
        dispatch({ type: "thread-loaded", project, bootstrap: prepared.bootstrap, workbench: prepared.workbench });
      } catch (value) {
        if (value instanceof DOMException && value.name === "AbortError") return;
        report(value);
      }
    },
    [report, threadActions],
  );

  const loadProject = useCallback(
    async (project: Project) => {
      const threads = await window.desktop.sessions.list(project.id, true);
      dispatch({ type: "project-loaded", project, threads });
      const preferredThreadId = activeThreadIds.current[project.id];
      const target =
        threads.find(({ archived, id }) => !archived && id === preferredThreadId) ??
        threads.find(({ archived }) => !archived);
      if (target) await loadThread(project, target.id);
      else {
        const actions = threadActions.current;
        if (!actions) throw new Error("assistant-ui thread adapter 尚未就绪");
        await actions.enterDraft();
        const generation = ++draftProjectGeneration.current;
        dispatch({ type: "draft-started", projectId: project.id });
        await loadDraftConfiguration(project.id, generation);
      }
    },
    [loadDraftConfiguration, loadThread, threadActions],
  );

  const loadProjectThreads = useCallback(
    (projectId: string) => {
      if (Object.hasOwn(threadCatalogs.current, projectId)) return Promise.resolve();
      const pending = pendingThreadCatalogs.current.get(projectId);
      if (pending) return pending;
      const promise = window.desktop.sessions
        .list(projectId, true)
        .then((threads) => dispatch({ type: "project-threads-loaded", projectId, threads }))
        .catch((value: unknown) => report(value))
        .finally(() => pendingThreadCatalogs.current.delete(projectId));
      pendingThreadCatalogs.current.set(projectId, promise);
      return promise;
    },
    [report],
  );

  useEffect(() => {
    let active = true;
    void Promise.all([window.desktop.projects.list(), window.desktop.projects.getActive()])
      .then(async ([projects, current]) => {
        if (!active) return;
        dispatch({ type: "projects-loaded", projects });
        if (current?.available) await loadProject(current);
      })
      .catch(report)
      .finally(() => {
        if (active) dispatch({ type: "loading", loading: false });
      });
    return () => {
      active = false;
    };
  }, [loadProject, report]);

  useEffect(() => sessionEventBus.onControl((control) => dispatch({ type: "control", control })), []);
  useEffect(
    () => () => {
      void threadActions.current?.detach();
    },
    [threadActions],
  );

  const chooseProject = useCallback(async () => {
    if (draft.current?.phase === "materializing" || pendingDraftProjectSelection.current) return;
    try {
      const project = await window.desktop.projects.choose();
      if (!project) return;
      dispatch({ type: "project-upserted", project });
      if (draft.current) {
        const generation = ++draftProjectGeneration.current;
        dispatch({ type: "draft-project-selected", projectId: project.id });
        await loadDraftConfiguration(project.id, generation);
      } else await loadProject(project);
    } catch (value) {
      report(value);
    }
  }, [loadDraftConfiguration, loadProject, report]);

  const removeProject = useCallback(
    async (projectId: string) => {
      if (draft.current?.phase === "materializing") return;
      try {
        draftProjectGeneration.current += 1;
        await window.desktop.projects.remove(projectId);
        if (activeProjectId.current === projectId && draft.current?.projectId !== projectId) {
          await threadActions.current?.detach();
        }
        dispatch({ type: "project-removed", projectId });
      } catch (value) {
        report(value);
      }
    },
    [report, threadActions],
  );

  const beginDraft = useCallback(
    async (projectId?: string) => {
      if (draft.current || pendingDraftSubmission.current) return;
      try {
        const selected = projectId
          ? state.projects.find((project) => project.id === projectId && project.available)
          : ((state.project?.available ? state.project : undefined) ??
            state.projects.find(({ available }) => available));
        if (!selected) throw new Error("新建会话前必须先添加可用的 Project");
        const actions = threadActions.current;
        if (!actions) throw new Error("assistant-ui thread adapter 尚未就绪");
        await actions.enterDraft();
        const generation = ++draftProjectGeneration.current;
        dispatch({ type: "draft-started", projectId: selected.id });
        await loadDraftConfiguration(selected.id, generation);
      } catch (value) {
        report(value);
      }
    },
    [loadDraftConfiguration, report, state.project, state.projects, threadActions],
  );

  const selectDraftProject = useCallback(
    async (projectId: string) => {
      if (!draft.current || draft.current.phase === "materializing") return;
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
    [loadDraftConfiguration, report, state.projects],
  );

  const selectDraftModel = useCallback((provider: string, modelId: string) => {
    if (draft.current?.phase !== "editing") return;
    dispatch({ type: "draft-model-selected", provider, modelId });
  }, []);

  const selectDraftThinking = useCallback((thinkingLevel: ThinkingLevel) => {
    if (draft.current?.phase !== "editing") return;
    dispatch({ type: "draft-thinking-selected", thinkingLevel });
  }, []);

  const submitDraft = useCallback(() => {
    return runDraftSubmissionSingleFlight(pendingDraftSubmission, async () => {
      if (pendingDraftProjectSelection.current) throw new Error("Project 切换完成后才能发送");
      const currentDraft = draft.current;
      const project = state.projects.find(({ id }) => id === currentDraft?.projectId);
      if (!currentDraft || !project?.available) throw new Error("发送前必须选择可用的 Project");
      const config = currentDraft.config;
      if (currentDraft.configLoading || !config) throw new Error("模型配置加载完成后才能发送");
      if (config.readiness.state !== "ready" || !config.model) {
        throw new Error(config.readiness.message ?? "发送前必须选择可用的模型");
      }
      const actions = threadActions.current;
      if (!actions) throw new Error("assistant-ui thread adapter 尚未就绪");
      try {
        const prepared = await actions.submitDraft(
          {
            project,
            model: { provider: config.model.provider, id: config.model.id },
            thinkingLevel: config.thinkingLevel,
          },
          () => dispatch({ type: "draft-materializing" }),
        );
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
  }, [report, state.projects, threadActions]);

  const discardDraft = useCallback(async () => {
    if (!draft.current || pendingDraftSubmission.current) return;
    draftProjectGeneration.current += 1;
    const actions = threadActions.current;
    if (!actions) throw new Error("assistant-ui thread adapter 尚未就绪");
    const prepared = await actions.discardDraft();
    if (!prepared) {
      dispatch({ type: "draft-discarded" });
      return;
    }
    const project = state.projects.find(({ id }) => id === prepared.bootstrap.projectId);
    if (!project) throw new Error(`恢复的 session 缺少 Project: ${prepared.bootstrap.projectId}`);
    const openedProject = await window.desktop.projects.open(project.id);
    dispatch({
      type: "thread-loaded",
      project: openedProject,
      bootstrap: prepared.bootstrap,
      workbench: prepared.workbench,
    });
  }, [state.projects, threadActions]);

  const openThread = useCallback(
    async (projectId: string, threadId: string) => {
      if (draft.current?.phase === "materializing") return;
      try {
        const leavingDraft = draft.current !== null;
        draftProjectGeneration.current += 1;
        const project =
          !leavingDraft && state.project?.id === projectId
            ? state.project
            : await window.desktop.projects.open(projectId);
        await loadThread(project, threadId);
      } catch (value) {
        report(value);
      }
    },
    [loadThread, report, state.project],
  );

  const renameThread = useCallback(
    async (projectId: string, threadId: string, title: string) => {
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
    [report, state.projects, threadActions],
  );

  const setThreadArchived = useCallback(
    async (projectId: string, threadId: string, archived: boolean) => {
      const project = state.projects.find(({ id }) => id === projectId);
      if (!project) return;
      try {
        const actions = threadActions.current;
        if (!actions) throw new Error("assistant-ui thread adapter 尚未就绪");
        await actions.archive(project, threadId, archived);
        dispatch({ type: "thread-archived", projectId, threadId, archived });
        if (archived && state.project?.id === projectId && activeThreadId === threadId) {
          const nextThreadId = nextRegularThreadId(state.threadCatalogs[projectId] ?? [], threadId);
          if (nextThreadId) await loadThread(project, nextThreadId);
          else {
            await actions.detach();
            dispatch({ type: "thread-cleared", projectId });
          }
        }
      } catch (value) {
        report(value);
      }
    },
    [activeThreadId, loadThread, report, state.project?.id, state.projects, state.threadCatalogs, threadActions],
  );

  const removeThread = useCallback(
    async (projectId: string, threadId: string) => {
      const project = state.projects.find(({ id }) => id === projectId);
      if (!project) return;
      try {
        const actions = threadActions.current;
        if (!actions) throw new Error("assistant-ui thread adapter 尚未就绪");
        await actions.remove(project, threadId);
        dispatch({ type: "thread-removed", projectId, threadId });
        if (state.project?.id === projectId && activeThreadId === threadId) {
          const nextThreadId = nextRegularThreadId(state.threadCatalogs[projectId] ?? [], threadId);
          if (nextThreadId) await loadThread(project, nextThreadId);
          else {
            await actions.detach();
            dispatch({ type: "thread-cleared", projectId });
          }
        }
      } catch (value) {
        report(value);
      }
    },
    [activeThreadId, loadThread, report, state.project?.id, state.projects, state.threadCatalogs, threadActions],
  );

  const updateWorkbench = useCallback(
    (value: Partial<WorkbenchState>) => {
      if (!state.project || !activeThreadId) return;
      const key = sessionKey(state.project.id, activeThreadId);
      const previous = state.workbenches[key];
      if (!previous) return;
      const workbench = { ...previous, ...value };
      dispatch({ type: "workbench", workbench });
      void window.desktop.workbench.update(workbench).catch(report);
    },
    [activeThreadId, report, state.project, state.workbenches],
  );

  const key = state.project && activeThreadId ? sessionKey(state.project.id, activeThreadId) : "";
  const bootstrap =
    state.bootstrap && sessionKey(state.bootstrap.projectId, state.bootstrap.threadId) === key ? state.bootstrap : null;
  return useMemo(
    () => ({
      projects: state.projects,
      project: state.project,
      draft: state.draft,
      threads,
      threadCatalogs: state.threadCatalogs,
      threadId: activeThreadId,
      bootstrap,
      snapshot: state.controls[key] ?? bootstrap?.control ?? null,
      workbench: state.workbenches[key] ?? null,
      loading: state.loading,
      error: state.error,
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
      updateWorkbench,
      clearError: () => dispatch({ type: "error", error: null }),
    }),
    [
      state,
      key,
      bootstrap,
      threads,
      activeThreadId,
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
      updateWorkbench,
    ],
  );
}
