import type { Thread } from "../../../shared/contracts.ts";
import type { DesktopState } from "./desktop-model.ts";

export function selectProjects(state: DesktopState) {
  return state.projects;
}

export function selectHasAvailableProject(state: DesktopState): boolean {
  return state.projects.some(({ available }) => available);
}

export function selectProjectThreads(state: DesktopState, projectId: string): Thread[] | undefined {
  return state.threadCatalogs[projectId];
}
