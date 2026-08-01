import type { Thread } from "../../../shared/contracts.ts";
import type { DesktopState } from "./desktop-model.ts";

/** 全部 workspace，包括通用对话。 */
export function selectProjects(state: DesktopState) {
  return state.projects;
}

export function selectHasAvailableProject(state: DesktopState): boolean {
  return state.projects.some(({ available }) => available);
}

export function selectProjectThreads(state: DesktopState, projectId: string): Thread[] | undefined {
  return state.threadCatalogs[projectId];
}

export type SessionCatalogStatus = "project-unavailable" | "threads-unloaded" | "thread-invalid" | "ready";

/** 校验 session 路由目标在窗口级目录中的身份状态。 */
export function selectSessionCatalogStatus(
  state: DesktopState,
  projectId: string,
  threadId: string,
): SessionCatalogStatus {
  if (!state.projects.find(({ id }) => id === projectId)?.available) return "project-unavailable";
  const threads = state.threadCatalogs[projectId];
  if (!threads) return "threads-unloaded";
  return threads.some((thread) => thread.id === threadId && thread.projectId === projectId && !thread.archived)
    ? "ready"
    : "thread-invalid";
}
