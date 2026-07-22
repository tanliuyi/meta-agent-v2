import { useNavigate, useRouterState } from "@tanstack/react-router";
import { type ReactNode, useCallback, useEffect, useMemo, useRef } from "react";
import { useStore } from "zustand";
import { sessionRecordKey } from "../runtime/pi-session-store.ts";
import type { DesktopActions } from "./desktop-actions.ts";
import { DesktopActionsContext } from "./desktop-context.tsx";
import { dispatchDesktop } from "./desktop-store.ts";
import { useDesktopStore } from "./desktop-store-context.tsx";
import { useSessionCache } from "./session-cache-context.tsx";

interface DesktopCatalogProviderProps {
  children: ReactNode;
  enabled: boolean;
}

/** Window-level catalog owner. It intentionally never attaches a session or creates an assistant runtime. */
export function DesktopCatalogProvider({ children, enabled }: DesktopCatalogProviderProps) {
  const store = useDesktopStore();
  const projects = useStore(store, (state) => state.projects);
  const cache = useSessionCache();
  const navigate = useNavigate();
  const route = useRouterState({ select: (state) => state.location.pathname });
  const catalogRequests = useRef(new Map<string, Promise<void>>());
  const initialized = useRef(false);

  const loadProjectThreads = useCallback(
    (projectId: string) => {
      if (catalogRequests.current.has(projectId)) return catalogRequests.current.get(projectId)!;
      const request = window.desktop.sessions
        .list(projectId, true)
        .then((threads) => dispatchDesktop(store, { type: "project-threads-loaded", projectId, threads }))
        .finally(() => catalogRequests.current.delete(projectId));
      catalogRequests.current.set(projectId, request);
      return request;
    },
    [store],
  );

  useEffect(() => {
    if (!enabled || initialized.current) return;
    initialized.current = true;
    void window.desktop.projects
      .list()
      .then((next) => dispatchDesktop(store, { type: "projects-loaded", projects: next }))
      .catch((error: unknown) => {
        initialized.current = false;
        dispatchDesktop(store, { type: "error", error: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => dispatchDesktop(store, { type: "loading", loading: false }));
  }, [enabled, store]);

  const actions = useMemo<DesktopActions>(
    () => ({
      async chooseProject() {
        const project = await window.desktop.projects.choose();
        if (!project) return;
        dispatchDesktop(store, { type: "project-upserted", project });
        await loadProjectThreads(project.id);
      },
      loadProjectThreads,
      async removeProject(projectId) {
        await cache.retireProject(projectId);
        await window.desktop.projects.remove(projectId);
        dispatchDesktop(store, { type: "project-removed", projectId });
        if (route.includes(`/projects/${projectId}/`)) await navigate({ to: "/", replace: true });
      },
      async beginDraft(projectId) {
        const target = projectId ?? projects.find((project) => project.available)?.id;
        await navigate({ to: "/new", search: target ? { projectId: target } : undefined });
      },
      async selectDraftProject() {},
      selectDraftModel() {},
      selectDraftThinking() {},
      async submitDraft() {},
      async discardDraft() {},
      prewarmThread(projectId, threadId) {
        void window.desktop.sessions.prewarm(projectId, threadId).catch(() => undefined);
      },
      async openThread(projectId, threadId) {
        await navigate({ to: "/projects/$projectId/session/$threadId", params: { projectId, threadId } });
      },
      async branchFromThread(projectId, threadId, sourceEntryId) {
        const branch = await window.desktop.sessions.branch({
          requestId: crypto.randomUUID(),
          projectId,
          threadId,
          sourceEntryId,
        });
        await loadProjectThreads(projectId);
        await navigate({
          to: "/projects/$projectId/session/$threadId",
          params: { projectId, threadId: branch.branchThreadId },
        });
      },
      async renameThread(projectId, threadId, title) {
        await window.desktop.sessions.rename(projectId, threadId, title);
        dispatchDesktop(store, { type: "thread-renamed", projectId, threadId, title });
      },
      async setThreadArchived(projectId, threadId, archived) {
        if (archived) await cache.retire(sessionRecordKey(projectId, threadId));
        await window.desktop.sessions.archive(projectId, threadId, archived);
        dispatchDesktop(store, { type: "thread-archived", projectId, threadId, archived });
        if (archived && route.endsWith(`/projects/${projectId}/session/${threadId}`))
          await navigate({ to: "/", replace: true });
      },
      async removeThread(projectId, threadId) {
        await cache.retire(sessionRecordKey(projectId, threadId));
        await window.desktop.sessions.remove(projectId, threadId);
        dispatchDesktop(store, { type: "thread-removed", projectId, threadId });
        if (route.endsWith(`/projects/${projectId}/session/${threadId}`)) await navigate({ to: "/", replace: true });
      },
      async clearQueue() {},
      async compactSession() {},
      updateWorkbench() {},
      clearError() {
        dispatchDesktop(store, { type: "error", error: null });
      },
    }),
    [cache, loadProjectThreads, navigate, projects, route, store],
  );

  return <DesktopActionsContext.Provider value={actions}>{children}</DesktopActionsContext.Provider>;
}
