import type { Project, SessionBootstrap, Thread } from "../../../shared/contracts.ts";

export interface DesktopState {
  projects: Project[];
  activeProjectId: string | null;
  threadCatalogs: Record<string, Thread[]>;
  loading: boolean;
  error: string | null;
}

export const INITIAL_STATE: DesktopState = {
  projects: [],
  activeProjectId: null,
  threadCatalogs: {},
  loading: true,
  error: null,
};

export type DesktopAction =
  | { type: "projects-loaded"; projects: Project[]; activeProjectId: string | null }
  | { type: "project-upserted"; project: Project }
  | { type: "project-activated"; projectId: string }
  | { type: "project-threads-loaded"; projectId: string; threads: Thread[] }
  | { type: "thread-catalog-added"; bootstrap: SessionBootstrap }
  | { type: "project-removed"; projectId: string }
  | { type: "thread-renamed"; projectId: string; threadId: string; title: string }
  | { type: "thread-archived"; projectId: string; threadId: string; archived: boolean }
  | { type: "thread-removed"; projectId: string; threadId: string }
  | {
      type: "thread-summary-updated";
      projectId: string;
      threadId: string;
      title: string;
      updatedAt: number;
      running: boolean;
    }
  | { type: "loading"; loading: boolean }
  | { type: "error"; error: string | null };

/** Window-level reducer. Session timeline, control, connection, and workbench stay in cached records. */
export function desktopReducer(state: DesktopState, action: DesktopAction): DesktopState {
  switch (action.type) {
    case "projects-loaded":
      return {
        ...state,
        projects: action.projects,
        activeProjectId: action.activeProjectId,
      };
    case "project-upserted": {
      const index = state.projects.findIndex(({ id }) => id === action.project.id);
      if (index === -1) {
        return { ...state, projects: [action.project, ...state.projects], activeProjectId: action.project.id };
      }
      const projects = [...state.projects];
      projects[index] = action.project;
      return { ...state, projects, activeProjectId: action.project.id };
    }
    case "project-activated":
      return state.activeProjectId === action.projectId ? state : { ...state, activeProjectId: action.projectId };
    case "project-threads-loaded":
      return {
        ...state,
        threadCatalogs: {
          ...state.threadCatalogs,
          [action.projectId]: reuseThreadCatalog(state.threadCatalogs[action.projectId], action.threads),
        },
      };
    case "thread-catalog-added": {
      const thread = threadFromBootstrap(action.bootstrap);
      const current = state.threadCatalogs[thread.projectId] ?? [];
      return {
        ...state,
        threadCatalogs: {
          ...state.threadCatalogs,
          [thread.projectId]: [thread, ...current.filter(({ id }) => id !== thread.id)],
        },
      };
    }
    case "project-removed": {
      const threadCatalogs = { ...state.threadCatalogs };
      delete threadCatalogs[action.projectId];
      return {
        ...state,
        projects: state.projects.filter(({ id }) => id !== action.projectId),
        activeProjectId: state.activeProjectId === action.projectId ? null : state.activeProjectId,
        threadCatalogs,
      };
    }
    case "thread-renamed":
      return updateProjectThreads(state, action.projectId, (thread) =>
        thread.id === action.threadId ? { ...thread, title: action.title } : thread,
      );
    case "thread-archived":
      return updateProjectThreads(state, action.projectId, (thread) =>
        thread.id === action.threadId ? { ...thread, archived: action.archived } : thread,
      );
    case "thread-removed":
      return {
        ...state,
        threadCatalogs: {
          ...state.threadCatalogs,
          [action.projectId]: (state.threadCatalogs[action.projectId] ?? []).filter(({ id }) => id !== action.threadId),
        },
      };
    case "thread-summary-updated": {
      const threads = state.threadCatalogs[action.projectId];
      if (!threads) return state;
      const index = threads.findIndex(({ id }) => id === action.threadId);
      const current = threads[index];
      if (
        !current ||
        (current.title === action.title && current.updatedAt === action.updatedAt && current.running === action.running)
      ) {
        return state;
      }
      const next = [...threads];
      next[index] = {
        ...current,
        title: action.title,
        updatedAt: action.updatedAt,
        running: action.running,
      };
      next.sort((left, right) => right.updatedAt - left.updatedAt);
      return { ...state, threadCatalogs: { ...state.threadCatalogs, [action.projectId]: next } };
    }
    case "loading":
      return state.loading === action.loading ? state : { ...state, loading: action.loading };
    case "error":
      return state.error === action.error ? state : { ...state, error: action.error };
  }
}

export function threadFromBootstrap(bootstrap: SessionBootstrap): Thread {
  const visible = bootstrap.timeline.nodes.filter((node) => node.kind === "user" || node.kind === "assistant");
  const firstUser = visible.find((node) => node.kind === "user");
  const preview =
    firstUser?.kind === "user"
      ? firstUser.content
          .flatMap((part) => (part.type === "text" ? [part.text] : []))
          .join("\n")
          .slice(0, 120)
      : "";
  return {
    id: bootstrap.threadId,
    projectId: bootstrap.projectId,
    title: bootstrap.control.title,
    createdAt: visible[0]?.createdAt ?? bootstrap.control.updatedAt,
    updatedAt: bootstrap.control.updatedAt,
    messageCount: visible.length,
    preview,
    archived: false,
    running: bootstrap.timeline.phase !== "idle",
  };
}

function updateProjectThreads(
  state: DesktopState,
  projectId: string,
  update: (thread: Thread) => Thread,
): DesktopState {
  const current = state.threadCatalogs[projectId] ?? [];
  const next = current.map(update);
  return next.every((thread, index) => thread === current[index])
    ? state
    : { ...state, threadCatalogs: { ...state.threadCatalogs, [projectId]: next } };
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
