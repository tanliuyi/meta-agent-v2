import { useNavigate, useRouterState } from "@tanstack/react-router";
import { type ReactNode, useCallback, useEffect, useMemo, useRef } from "react";
import { sessionRecordKey } from "../runtime/pi-session-store.ts";
import type { DesktopActions } from "./desktop-actions.ts";
import { DesktopActionsContext } from "./desktop-context.tsx";
import { dispatchDesktop } from "./desktop-store.ts";
import { useDesktopStore } from "./desktop-store-context.tsx";
import { ProjectActivationCoordinator } from "./project-activation.ts";
import { useSessionCache, useSessionCacheSnapshot } from "./session-cache-context.tsx";
import { SessionCatalogControlBridge } from "./session-catalog-control-bridge.tsx";

interface DesktopCatalogProviderProps {
  children: ReactNode;
}

/** Window-level Project and thread-summary owner. Session data remains in cached records. */
export function DesktopCatalogProvider({ children }: DesktopCatalogProviderProps) {
  const store = useDesktopStore();
  const cache = useSessionCache();
  const { records } = useSessionCacheSnapshot();
  const navigate = useNavigate();
  const route = useRouterState({ select: (state) => state.location.pathname });
  const catalogRequests = useRef(new Map<string, Promise<void>>());
  const catalogGenerations = useRef(new Map<string, number>());
  const projectActivation = useRef(new ProjectActivationCoordinator()).current;
  const initialized = useRef(false);

  const reportError = useCallback(
    (error: unknown) => {
      dispatchDesktop(store, { type: "error", error: error instanceof Error ? error.message : String(error) });
    },
    [store],
  );

  const invalidateProjectThreads = useCallback((projectId: string) => {
    catalogGenerations.current.set(projectId, (catalogGenerations.current.get(projectId) ?? 0) + 1);
    catalogRequests.current.delete(projectId);
  }, []);

  const requestProjectThreads = useCallback(
    (projectId: string, force: boolean) => {
      const existing = catalogRequests.current.get(projectId);
      if (existing && !force) return existing;

      const generation = (catalogGenerations.current.get(projectId) ?? 0) + 1;
      catalogGenerations.current.set(projectId, generation);
      const request = window.desktop.sessions
        .list(projectId, true)
        .then((threads) => {
          if (
            catalogGenerations.current.get(projectId) !== generation ||
            !store.getState().projects.some(({ id }) => id === projectId)
          )
            return;
          dispatchDesktop(store, { type: "project-threads-loaded", projectId, threads });
        })
        .catch((error: unknown) => {
          if (catalogGenerations.current.get(projectId) !== generation) return;
          reportError(error);
          throw error;
        })
        .finally(() => {
          if (catalogRequests.current.get(projectId) === request) catalogRequests.current.delete(projectId);
        });
      catalogRequests.current.set(projectId, request);
      return request;
    },
    [reportError, store],
  );

  const loadProjectThreads = useCallback(
    (projectId: string) => requestProjectThreads(projectId, false),
    [requestProjectThreads],
  );
  const refreshProjectThreads = useCallback(
    (projectId: string) => requestProjectThreads(projectId, true),
    [requestProjectThreads],
  );

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    void Promise.all([window.desktop.projects.list(), window.desktop.projects.getActive()])
      .then(([projects, active]) =>
        dispatchDesktop(store, {
          type: "projects-loaded",
          projects,
          activeProjectId: active?.available ? active.id : null,
        }),
      )
      .catch((error: unknown) => {
        initialized.current = false;
        reportError(error);
      })
      .finally(() => dispatchDesktop(store, { type: "loading", loading: false }));
  }, [reportError, store]);

  const actions = useMemo<DesktopActions>(
    () => ({
      async chooseProject() {
        try {
          const project = await window.desktop.projects.choose();
          if (!project) return;
          dispatchDesktop(store, { type: "project-upserted", project });
          await loadProjectThreads(project.id);
        } catch (error) {
          reportError(error);
          throw error;
        }
      },
      loadProjectThreads,
      refreshProjectThreads,
      async activateProject(projectId) {
        try {
          await projectActivation.activate(
            projectId,
            () => store.getState().activeProjectId === projectId,
            (targetProjectId) => window.desktop.projects.open(targetProjectId),
            (project) => dispatchDesktop(store, { type: "project-upserted", project }),
          );
        } catch (error) {
          reportError(error);
          throw error;
        }
      },
      async removeProject(projectId) {
        const restore = cache.quiesceProject(projectId);
        try {
          await window.desktop.projects.remove(projectId);
          invalidateProjectThreads(projectId);
          await cache.retireProject(projectId);
          dispatchDesktop(store, { type: "project-removed", projectId });
          if (route.includes(`/projects/${projectId}/`)) await navigate({ to: "/", replace: true });
        } catch (error) {
          restore();
          reportError(error);
          throw error;
        }
      },
      prewarmThread(projectId, threadId) {
        void window.desktop.sessions.prewarm(projectId, threadId).catch(() => undefined);
      },
      async renameThread(projectId, threadId, title) {
        try {
          await window.desktop.sessions.rename(projectId, threadId, title);
          dispatchDesktop(store, { type: "thread-renamed", projectId, threadId, title });
        } catch (error) {
          reportError(error);
          throw error;
        }
      },
      async setThreadArchived(projectId, threadId, archived) {
        const key = sessionRecordKey(projectId, threadId);
        const restore = archived ? cache.quiesce(key) : () => undefined;
        try {
          await window.desktop.sessions.archive(projectId, threadId, archived);
          if (archived) await cache.retire(key);
          dispatchDesktop(store, { type: "thread-archived", projectId, threadId, archived });
          if (archived && route.endsWith(`/projects/${projectId}/session/${threadId}`)) {
            await navigate({ to: "/", replace: true });
          }
        } catch (error) {
          restore();
          reportError(error);
          throw error;
        }
      },
      async removeThread(projectId, threadId) {
        const key = sessionRecordKey(projectId, threadId);
        const restore = cache.quiesce(key);
        try {
          await window.desktop.sessions.remove(projectId, threadId);
          await cache.retire(key);
          dispatchDesktop(store, { type: "thread-removed", projectId, threadId });
          if (route.endsWith(`/projects/${projectId}/session/${threadId}`)) {
            await navigate({ to: "/", replace: true });
          }
        } catch (error) {
          restore();
          reportError(error);
          throw error;
        }
      },
      clearError() {
        dispatchDesktop(store, { type: "error", error: null });
      },
    }),
    [
      cache,
      invalidateProjectThreads,
      loadProjectThreads,
      navigate,
      projectActivation,
      refreshProjectThreads,
      reportError,
      route,
      store,
    ],
  );

  return (
    <DesktopActionsContext.Provider value={actions}>
      {records.map((record) => (
        <SessionCatalogControlBridge key={record.key} record={record} store={store} />
      ))}
      {children}
    </DesktopActionsContext.Provider>
  );
}
