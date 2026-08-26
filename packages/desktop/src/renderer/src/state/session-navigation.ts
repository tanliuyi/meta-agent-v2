import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import { GENERAL_WORKSPACE_ID, type Project } from "../../../shared/contracts.ts";
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

/** 当前 route 将被 catalog mutation 移除时，先完成导航，避免渲染短暂的 invalid route。 */
export async function commitCatalogRemovalAfterRouteExit(
  removesActiveRoute: boolean,
  exitRoute: () => Promise<void>,
  commit: () => Promise<void> | void,
): Promise<void> {
  let exitError: unknown;
  let exitFailed = false;
  if (removesActiveRoute) {
    try {
      await exitRoute();
    } catch (error) {
      exitFailed = true;
      exitError = error;
    }
  }
  await commit();
  if (exitFailed) throw exitError;
}

export function resolveDraftProjectId(
  projects: readonly Pick<Project, "id">[],
  requestedProjectId: string | undefined,
  selectedProjectId: string | null,
  allowFallback: boolean,
  storedProjectId?: string | null,
): string | null {
  if (requestedProjectId && projects.some((project) => project.id === requestedProjectId)) return requestedProjectId;
  if (selectedProjectId && projects.some((project) => project.id === selectedProjectId)) return selectedProjectId;
  // 内存中的选择已失效时保持未选择，等待用户显式选择；不复活持久化的旧项目。
  if (selectedProjectId) return null;
  // 重启或首次进入时，恢复最近使用的项目。
  if (allowFallback && storedProjectId && projects.some((project) => project.id === storedProjectId)) {
    return storedProjectId;
  }
  if (!allowFallback) return null;
  // 通用工作区始终可用，作为兜底选项
  if (projects.some((project) => project.id === GENERAL_WORKSPACE_ID)) return GENERAL_WORKSPACE_ID;
  return projects[0]?.id ?? null;
}

/**
 * 从已加载的 project 列表中解析根入口默认导航目标。
 * 优先级：可用的通用工作区 → draftProjectId → activeProjectId → 第一个可用 Project。
 * 无匹配时返回 null。
 */
export function resolveRootTarget(
  projects: readonly Pick<Project, "id" | "available">[],
  draftProjectId: string | null,
  activeProjectId: string | null,
): string | null {
  const candidate =
    projects.find((p) => p.id === GENERAL_WORKSPACE_ID && p.available) ??
    projects.find((p) => p.id === draftProjectId && p.available) ??
    projects.find((p) => p.id === activeProjectId && p.available);
  if (candidate) return candidate.id;
  return projects.find((p) => p.available)?.id ?? null;
}

/**
 * Navigate to a session route.
 * This is the only way to switch sessions — no runtime.threads.switchToThread().
 */
export function useSessionNavigation() {
  const navigate = useNavigate();
  const openSession = useCallback(
    (projectId: string, threadId: string) =>
      navigate({
        to: "/projects/$projectId/session/$threadId",
        params: { projectId, threadId },
      }),
    [navigate],
  );
  const openDraft = useCallback(
    (projectId?: string) =>
      navigate({
        to: "/new",
        search: draftSearch(projectId),
      }),
    [navigate],
  );
  const replaceSession = useCallback(
    (projectId: string, threadId: string) =>
      navigate({
        to: "/projects/$projectId/session/$threadId",
        params: { projectId, threadId },
        replace: true,
      }),
    [navigate],
  );
  const replaceDraft = useCallback(
    (projectId?: string) =>
      navigate({
        to: "/new",
        search: draftSearch(projectId),
        replace: true,
      }),
    [navigate],
  );
  const goToRoot = useCallback(() => navigate({ to: "/" }), [navigate]);

  return useMemo(
    () => ({ openSession, openDraft, replaceSession, replaceDraft, goToRoot }),
    [goToRoot, openDraft, openSession, replaceDraft, replaceSession],
  );
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
