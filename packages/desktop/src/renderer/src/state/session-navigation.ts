import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import type { Project } from "../../../shared/contracts.ts";
import { useTransportManager } from "../runtime/session-transport-context";

/**
 * Typed navigation helpers for session routes.
 * These replace the old `openThread` / `beginDraft` that used runtime.threads.switchToThread().
 */

export interface SessionRouteParams {
  projectId: string;
  threadId: string;
}

export interface DraftSearchParams {
  projectId?: string;
}

export function validateDraftSearch(search: Record<string, unknown>): DraftSearchParams {
  const projectId = typeof search.projectId === "string" && search.projectId.length > 0 ? search.projectId : undefined;
  return projectId ? { projectId } : {};
}

export function draftSearch(projectId?: string): DraftSearchParams {
  return projectId ? { projectId } : {};
}

export function resolveDraftProjectId(
  projects: readonly Pick<Project, "id">[],
  requestedProjectId: string | undefined,
  selectedProjectId: string | null,
  allowFallback: boolean,
): string | null {
  if (requestedProjectId && projects.some((project) => project.id === requestedProjectId)) return requestedProjectId;
  if (selectedProjectId && projects.some((project) => project.id === selectedProjectId)) return selectedProjectId;
  if (selectedProjectId || !allowFallback) return null;
  return projects[0]?.id ?? null;
}

/**
 * Navigate to a session route.
 * This is the only way to switch sessions — no runtime.threads.switchToThread().
 */
export function useSessionNavigation() {
  const navigate = useNavigate();

  return {
    openSession(projectId: string, threadId: string) {
      return navigate({
        to: "/projects/$projectId/session/$threadId",
        params: { projectId, threadId },
      });
    },

    openDraft(projectId?: string) {
      return navigate({
        to: "/new",
        search: draftSearch(projectId),
      });
    },

    replaceSession(projectId: string, threadId: string) {
      return navigate({
        to: "/projects/$projectId/session/$threadId",
        params: { projectId, threadId },
        replace: true,
      });
    },

    replaceDraft(projectId?: string) {
      return navigate({
        to: "/new",
        search: draftSearch(projectId),
        replace: true,
      });
    },

    goToRoot() {
      return navigate({ to: "/" });
    },
  };
}

export function useSessionRouteParams(): SessionRouteParams | null {
  const params = useParams({ strict: false }) as Record<string, string | undefined>;
  if (params.projectId && params.threadId) {
    return { projectId: params.projectId, threadId: params.threadId };
  }
  return null;
}

export function useDraftSearchParams(): DraftSearchParams {
  const search = useSearch({ strict: false }) as Record<string, string | undefined>;
  return { projectId: search.projectId };
}

/**
 * Bridge for app layer to access SessionTransportManager without direct runtime import.
 * `state` layer is allowed to import `runtime`, so this re-export avoids boundary violations.
 */
export function useSessionTransport() {
  return useTransportManager();
}
