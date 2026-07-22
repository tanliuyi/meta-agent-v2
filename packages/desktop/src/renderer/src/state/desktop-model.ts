import type {
  DraftSessionConfig,
  Project,
  SessionBootstrap,
  SessionControlState,
  Thread,
  WorkbenchState,
} from "../../../shared/contracts.ts";
import { mergeSessionControl } from "./session-control-identity.ts";

export interface DraftSessionState {
  projectId: string | null;
  config: DraftSessionConfig | null;
  configLoading: boolean;
  phase: "editing" | "materializing";
}

interface PendingThreadLoad {
  projectId: string;
  threadId: string;
}

export interface DesktopState {
  projects: Project[];
  project: Project | null;
  draft: DraftSessionState | null;
  threadCatalogs: Record<string, Thread[]>;
  activeThreadIds: Record<string, string | undefined>;
  pendingThreadLoad: PendingThreadLoad | null;
  bootstrap: SessionBootstrap | null;
  controls: Record<string, SessionControlState>;
  workbenches: Record<string, WorkbenchState>;
  loading: boolean;
  error: string | null;
  /** Set by session route to prevent controller auto-draft on route-driven nav */
  routeNavigation: { projectId: string; threadId: string } | null;
}

export const INITIAL_STATE: DesktopState = {
  projects: [],
  project: null,
  draft: null,
  threadCatalogs: {},
  activeThreadIds: {},
  pendingThreadLoad: null,
  bootstrap: null,
  controls: {},
  workbenches: {},
  loading: true,
  routeNavigation: null,
  error: null,
};

export type DesktopAction =
  | { type: "projects-loaded"; projects: Project[] }
  | { type: "project-upserted"; project: Project }
  | { type: "project-threads-loaded"; projectId: string; threads: Thread[] }
  | { type: "project-loaded"; project: Project; threads: Thread[] }
  | { type: "project-removed"; projectId: string }
  | { type: "draft-started"; projectId: string }
  | { type: "draft-project-selected"; projectId: string }
  | { type: "draft-config-loaded"; projectId: string; config: DraftSessionConfig }
  | { type: "draft-config-failed"; projectId: string }
  | { type: "draft-model-selected"; provider: string; modelId: string }
  | { type: "draft-thinking-selected"; thinkingLevel: SessionControlState["thinkingLevel"] }
  | { type: "draft-materializing" }
  | { type: "draft-restored" }
  | {
      type: "draft-committed";
      project: Project;
      thread: Thread;
      bootstrap: SessionBootstrap;
      workbench: WorkbenchState;
    }
  | { type: "draft-discarded" }
  | { type: "thread-load-started"; project: Project; threadId: string }
  | { type: "thread-load-failed"; projectId: string; threadId: string }
  | { type: "thread-loaded"; project: Project; bootstrap: SessionBootstrap; workbench: WorkbenchState }
  | { type: "thread-created"; thread: Thread; bootstrap: SessionBootstrap; workbench: WorkbenchState }
  | { type: "thread-renamed"; projectId: string; threadId: string; title: string }
  | { type: "thread-archived"; projectId: string; threadId: string; archived: boolean }
  | { type: "thread-removed"; projectId: string; threadId: string }
  | { type: "thread-cleared"; projectId: string }
  | { type: "control"; control: SessionControlState }
  | { type: "workbench"; workbench: WorkbenchState }
  | { type: "loading"; loading: boolean }
  | { type: "error"; error: string | null };

/** 对 Desktop renderer 的低频控制状态执行无副作用更新。 */
export function desktopReducer(state: DesktopState, action: DesktopAction): DesktopState {
  if (action.type === "projects-loaded") return { ...state, projects: action.projects.toReversed() };
  if (action.type === "project-upserted") {
    const index = state.projects.findIndex(({ id }) => id === action.project.id);
    if (index === -1) return { ...state, projects: [action.project, ...state.projects] };
    const projects = [...state.projects];
    projects[index] = action.project;
    return { ...state, projects };
  }
  if (action.type === "project-threads-loaded") {
    return {
      ...state,
      threadCatalogs: {
        ...state.threadCatalogs,
        [action.projectId]: reuseThreadCatalog(state.threadCatalogs[action.projectId], action.threads),
      },
    };
  }
  if (action.type === "project-loaded") {
    const activeThreadId = state.activeThreadIds[action.project.id];
    const preserveActiveThread = action.threads.some((thread) => thread.id === activeThreadId && !thread.archived);
    const preserveActiveBootstrap =
      preserveActiveThread &&
      state.bootstrap?.projectId === action.project.id &&
      state.bootstrap.threadId === activeThreadId;
    return {
      ...state,
      project: action.project,
      bootstrap: preserveActiveBootstrap ? state.bootstrap : null,
      threadCatalogs: {
        ...state.threadCatalogs,
        [action.project.id]: reuseThreadCatalog(state.threadCatalogs[action.project.id], action.threads),
      },
      activeThreadIds: {
        ...state.activeThreadIds,
        [action.project.id]: preserveActiveThread ? activeThreadId : undefined,
      },
    };
  }
  if (action.type === "project-removed") {
    const current = state.project?.id === action.projectId;
    const draft =
      state.draft?.projectId === action.projectId
        ? { projectId: null, config: null, configLoading: false, phase: "editing" as const }
        : state.draft;
    const threadCatalogs = { ...state.threadCatalogs };
    const activeThreadIds = { ...state.activeThreadIds };
    const pendingRemoved = state.pendingThreadLoad?.projectId === action.projectId;
    delete threadCatalogs[action.projectId];
    delete activeThreadIds[action.projectId];
    return {
      ...state,
      projects: state.projects.filter(({ id }) => id !== action.projectId),
      project: current ? null : state.project,
      draft,
      threadCatalogs,
      activeThreadIds,
      pendingThreadLoad: pendingRemoved ? null : state.pendingThreadLoad,
      bootstrap: state.bootstrap?.projectId === action.projectId ? null : state.bootstrap,
      controls: withoutProjectSessions(state.controls, action.projectId),
      workbenches: withoutProjectSessions(state.workbenches, action.projectId),
      loading: pendingRemoved ? false : state.loading,
    };
  }
  if (action.type === "draft-started") {
    return {
      ...state,
      bootstrap: null,
      draft: { projectId: action.projectId, config: null, configLoading: true, phase: "editing" },
      pendingThreadLoad: null,
      loading: false,
    };
  }
  if (action.type === "draft-project-selected") {
    return {
      ...state,
      draft: { projectId: action.projectId, config: null, configLoading: true, phase: "editing" },
    };
  }
  if (action.type === "draft-config-loaded") {
    if (!state.draft || state.draft.projectId !== action.projectId) return state;
    return { ...state, draft: { ...state.draft, config: action.config, configLoading: false } };
  }
  if (action.type === "draft-config-failed") {
    if (!state.draft || state.draft.projectId !== action.projectId) return state;
    return { ...state, draft: { ...state.draft, config: null, configLoading: false } };
  }
  if (action.type === "draft-model-selected") {
    const config = state.draft?.config;
    const model = config?.models.find(({ provider, id }) => provider === action.provider && id === action.modelId);
    if (!state.draft || !config || !model) return state;
    const thinkingLevel = clampDraftThinking(config.thinkingLevel, model.thinkingLevels);
    return {
      ...state,
      draft: {
        ...state.draft,
        config: {
          ...config,
          model: { provider: model.provider, id: model.id, name: model.name },
          thinkingLevel,
          thinkingLevels: model.thinkingLevels,
          readiness: { state: "ready" },
        },
      },
    };
  }
  if (action.type === "draft-thinking-selected") {
    const config = state.draft?.config;
    if (!state.draft || !config?.thinkingLevels.includes(action.thinkingLevel)) return state;
    return { ...state, draft: { ...state.draft, config: { ...config, thinkingLevel: action.thinkingLevel } } };
  }
  if (action.type === "draft-materializing") {
    if (!state.draft || state.draft.phase === "materializing") return state;
    return { ...state, draft: { ...state.draft, phase: "materializing" } };
  }
  if (action.type === "draft-restored") {
    if (!state.draft || state.draft.phase === "editing") return state;
    return { ...state, draft: { ...state.draft, phase: "editing" } };
  }
  if (action.type === "draft-discarded") return state.draft ? { ...state, draft: null } : state;
  if (action.type === "thread-load-started") {
    return {
      ...state,
      pendingThreadLoad: { projectId: action.project.id, threadId: action.threadId },
      loading: true,
    };
  }
  if (action.type === "thread-load-failed") {
    const pending = state.pendingThreadLoad;
    if (!pending || pending.projectId !== action.projectId || pending.threadId !== action.threadId) return state;
    return { ...state, pendingThreadLoad: null, loading: false };
  }
  if (action.type === "thread-loaded" || action.type === "thread-created" || action.type === "draft-committed") {
    const key = desktopSessionKey(action.bootstrap.projectId, action.bootstrap.threadId);
    const projectThreads = state.threadCatalogs[action.bootstrap.projectId] ?? [];
    const created = action.type === "thread-created" || action.type === "draft-committed";
    const control = newerControl(state.controls[key], action.bootstrap.control);
    const catalogs = created
      ? {
          ...state.threadCatalogs,
          [action.bootstrap.projectId]: [action.thread, ...projectThreads.filter(({ id }) => id !== action.thread.id)],
        }
      : state.threadCatalogs;
    return {
      ...state,
      draft: null,
      ...(action.type === "thread-loaded" || action.type === "draft-committed" ? { project: action.project } : {}),
      threadCatalogs: control === action.bootstrap.control ? catalogs : updateThreadSummary(catalogs, control),
      activeThreadIds: {
        ...state.activeThreadIds,
        [action.bootstrap.projectId]: action.bootstrap.threadId,
      },
      pendingThreadLoad: null,
      bootstrap: action.bootstrap,
      controls: { ...state.controls, [key]: control },
      workbenches: { ...state.workbenches, [key]: action.workbench },
      routeNavigation:
        state.routeNavigation?.projectId === action.bootstrap.projectId &&
        state.routeNavigation?.threadId === action.bootstrap.threadId
          ? null
          : state.routeNavigation,
      loading: false,
    };
  }
  if (action.type === "thread-renamed") {
    return {
      ...state,
      threadCatalogs: updateProjectThreads(state.threadCatalogs, action.projectId, (thread) =>
        thread.id === action.threadId ? { ...thread, title: action.title } : thread,
      ),
    };
  }
  if (action.type === "thread-archived") {
    return {
      ...state,
      threadCatalogs: updateProjectThreads(state.threadCatalogs, action.projectId, (thread) =>
        thread.id === action.threadId ? { ...thread, archived: action.archived } : thread,
      ),
    };
  }
  if (action.type === "thread-removed") {
    const key = desktopSessionKey(action.projectId, action.threadId);
    const activeRemoved = state.activeThreadIds[action.projectId] === action.threadId;
    const pendingRemoved =
      state.pendingThreadLoad?.projectId === action.projectId && state.pendingThreadLoad.threadId === action.threadId;
    const clearNavigation = activeRemoved || pendingRemoved;
    return {
      ...state,
      threadCatalogs: {
        ...state.threadCatalogs,
        [action.projectId]: (state.threadCatalogs[action.projectId] ?? []).filter(({ id }) => id !== action.threadId),
      },
      activeThreadIds: activeRemoved
        ? { ...state.activeThreadIds, [action.projectId]: undefined }
        : state.activeThreadIds,
      pendingThreadLoad: clearNavigation ? null : state.pendingThreadLoad,
      bootstrap:
        activeRemoved ||
        (state.bootstrap?.projectId === action.projectId && state.bootstrap.threadId === action.threadId)
          ? null
          : state.bootstrap,
      controls: withoutSession(state.controls, key),
      workbenches: withoutSession(state.workbenches, key),
      loading: clearNavigation ? false : state.loading,
    };
  }
  if (action.type === "thread-cleared")
    return {
      ...state,
      activeThreadIds: { ...state.activeThreadIds, [action.projectId]: undefined },
      pendingThreadLoad: null,
      bootstrap: state.bootstrap?.projectId === action.projectId ? null : state.bootstrap,
      loading: false,
    };
  if (action.type === "control") return applyControl(state, action.control);
  if (action.type === "workbench") {
    const key = desktopSessionKey(action.workbench.projectId, action.workbench.threadId);
    return { ...state, workbenches: { ...state.workbenches, [key]: action.workbench } };
  }
  if (action.type === "loading") return { ...state, loading: action.loading || state.pendingThreadLoad !== null };
  return { ...state, error: action.error };
}

function applyControl(state: DesktopState, control: SessionControlState): DesktopState {
  const key = desktopSessionKey(control.projectId, control.threadId);
  const previous = state.controls[key];
  if (previous && previous.revision >= control.revision) return state;
  const merged = mergeSessionControl(previous, control);
  const threadCatalogs = updateThreadSummary(state.threadCatalogs, merged);
  return {
    ...state,
    controls: { ...state.controls, [key]: merged },
    threadCatalogs,
  };
}

function newerControl(previous: SessionControlState | undefined, bootstrap: SessionControlState): SessionControlState {
  return previous && previous.revision > bootstrap.revision ? previous : mergeSessionControl(previous, bootstrap);
}

function updateThreadSummary(
  catalogs: Record<string, Thread[]>,
  control: SessionControlState,
): Record<string, Thread[]> {
  const threads = catalogs[control.projectId];
  if (!threads) return catalogs;
  const index = threads.findIndex(({ id }) => id === control.threadId);
  const thread = threads[index];
  if (
    !thread ||
    (thread.title === control.title && thread.updatedAt === control.updatedAt && thread.running === control.running)
  )
    return catalogs;
  const next = [...threads];
  next[index] = { ...thread, title: control.title, updatedAt: control.updatedAt, running: control.running };
  next.sort((left, right) => right.updatedAt - left.updatedAt);
  return { ...catalogs, [control.projectId]: next };
}

/** 将 Project/thread identity 编码为 Desktop reducer 的本地缓存键。 */
export function desktopSessionKey(projectId: string, threadId: string): string {
  return `${projectId}:${threadId}`;
}

/** 从首次 attach 的权威 bootstrap 构造新 thread catalog 摘要。 */
export function threadFromBootstrap(bootstrap: SessionBootstrap): Thread {
  return {
    id: bootstrap.threadId,
    projectId: bootstrap.projectId,
    title: bootstrap.control.title,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messageCount: bootstrap.timeline.nodes.filter((message) => message.kind === "user" || message.kind === "assistant")
      .length,
    preview: "",
    archived: false,
    running: bootstrap.timeline.phase !== "idle",
  };
}

function updateProjectThreads(
  catalogs: Record<string, Thread[]>,
  projectId: string,
  update: (thread: Thread) => Thread,
): Record<string, Thread[]> {
  return { ...catalogs, [projectId]: (catalogs[projectId] ?? []).map(update) };
}

function withoutSession<T>(entries: Record<string, T>, key: string): Record<string, T> {
  if (!Object.hasOwn(entries, key)) return entries;
  const next = { ...entries };
  delete next[key];
  return next;
}

function withoutProjectSessions<T extends { projectId: string }>(
  entries: Record<string, T>,
  projectId: string,
): Record<string, T> {
  let next: Record<string, T> | undefined;
  for (const [key, value] of Object.entries(entries)) {
    if (value.projectId !== projectId) continue;
    next ??= { ...entries };
    delete next[key];
  }
  return next ?? entries;
}

function reuseThreadCatalog(previous: Thread[] | undefined, next: Thread[]): Thread[] {
  if (!previous || previous.length !== next.length) return next;
  return previous.every((thread, index) => equalThread(thread, next[index])) ? previous : next;
}

function equalThread(left: Thread, right: Thread | undefined): boolean {
  return (
    right !== undefined &&
    left.id === right.id &&
    left.projectId === right.projectId &&
    left.title === right.title &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt &&
    left.messageCount === right.messageCount &&
    left.preview === right.preview &&
    left.archived === right.archived &&
    left.running === right.running
  );
}

const THINKING_LEVELS: SessionControlState["thinkingLevel"][] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

function clampDraftThinking(
  requested: SessionControlState["thinkingLevel"],
  available: SessionControlState["thinkingLevels"],
): SessionControlState["thinkingLevel"] {
  if (available.includes(requested)) return requested;
  const requestedIndex = THINKING_LEVELS.indexOf(requested);
  for (let index = requestedIndex; index < THINKING_LEVELS.length; index += 1) {
    const candidate = THINKING_LEVELS[index];
    if (candidate && available.includes(candidate)) return candidate;
  }
  for (let index = requestedIndex - 1; index >= 0; index -= 1) {
    const candidate = THINKING_LEVELS[index];
    if (candidate && available.includes(candidate)) return candidate;
  }
  return "off";
}
