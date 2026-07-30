import { useNavigate, useRouter } from "@tanstack/react-router";
import { type ReactNode, useCallback, useEffect, useMemo, useRef } from "react";
import { sessionRecordKey } from "../runtime/pi-session-store.ts";
import type { DesktopActions } from "./desktop-actions.ts";
import { DesktopActionsContext } from "./desktop-context.tsx";
import { dispatchDesktop } from "./desktop-store.ts";
import { useDesktopStore } from "./desktop-store-context.tsx";
import { ProjectActivationCoordinator } from "./project-activation.ts";
import { useSessionCache, useSessionCacheRecords } from "./session-cache-context.tsx";
import { SessionCatalogControlBridge } from "./session-catalog-control-bridge.tsx";
import { commitCatalogRemovalAfterRouteExit, draftSearch } from "./session-navigation.ts";

interface DesktopCatalogProviderProps {
  children: ReactNode;
}

/** Window-level Project and thread-summary owner. Session data remains in cached records. */
export function DesktopCatalogProvider({ children }: DesktopCatalogProviderProps) {
  const store = useDesktopStore();
  const cache = useSessionCache();
  const records = useSessionCacheRecords();
  const navigate = useNavigate();
  const router = useRouter();
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

  useEffect(
    () =>
      window.desktop.sessions.onCatalogChanged((thread) => {
        dispatchDesktop(store, { type: "thread-catalog-upserted", thread });
      }),
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
      async renameProject(projectId, name) {
        try {
          const project = await window.desktop.projects.rename(projectId, name);
          dispatchDesktop(store, { type: "project-renamed", project });
        } catch (error) {
          reportError(error);
          throw error;
        }
      },
      async openProjectExternally(projectId) {
        try {
          await window.desktop.projects.openExternally(projectId);
        } catch (error) {
          reportError(error);
          throw error;
        }
      },
      async removeProject(projectId) {
        const restore = cache.quiesceProject(projectId);
        try {
          await window.desktop.projects.remove(projectId);
        } catch (error) {
          restore();
          reportError(error);
          throw error;
        }
        invalidateProjectThreads(projectId);
        try {
          await commitCatalogRemovalAfterRouteExit(
            router.state.location.pathname.includes(`/projects/${projectId}/`),
            () => navigate({ to: "/", replace: true }),
            async () => {
              await cache.retireProject(projectId);
              dispatchDesktop(store, { type: "project-removed", projectId });
            },
          );
        } catch (error) {
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
        } catch (error) {
          restore();
          reportError(error);
          throw error;
        }
        try {
          await commitCatalogRemovalAfterRouteExit(
            archived && router.state.location.pathname.endsWith(`/projects/${projectId}/session/${threadId}`),
            () => navigate({ to: "/new", search: draftSearch(projectId), replace: true }),
            async () => {
              if (archived) await cache.retire(key);
              dispatchDesktop(store, { type: "thread-archived", projectId, threadId, archived });
            },
          );
        } catch (error) {
          reportError(error);
          throw error;
        }
      },
      async removeThread(projectId, threadId, policy) {
        const key = sessionRecordKey(projectId, threadId);
        const restore = cache.quiesce(key);
        let result: Awaited<ReturnType<typeof window.desktop.sessions.remove>>;
        try {
          result = await window.desktop.sessions.remove(projectId, threadId, policy);
        } catch (error) {
          restore();
          reportError(error);
          throw error;
        }
        const retiredThreadIds = [...result.removedThreadIds, ...result.reparentedThreads.map(({ id }) => id)];
        try {
          await commitCatalogRemovalAfterRouteExit(
            result.removedThreadIds.some((id) =>
              router.state.location.pathname.endsWith(`/projects/${projectId}/session/${id}`),
            ),
            () => navigate({ to: "/new", search: draftSearch(projectId), replace: true }),
            async () => {
              await Promise.all(
                retiredThreadIds.map((retiredThreadId) => cache.retire(sessionRecordKey(projectId, retiredThreadId))),
              );
              dispatchDesktop(store, { type: "session-tree-removed", projectId, ...result });
            },
          );
        } catch (error) {
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
      router,
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
