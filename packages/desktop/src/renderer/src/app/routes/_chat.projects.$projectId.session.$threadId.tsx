import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useStore } from "zustand";
import { SessionCacheHost } from "../../components/session-cache-host.tsx";
import { useDesktopActions } from "../../state/desktop-context.tsx";
import type { DesktopState } from "../../state/desktop-model.ts";
import { useDesktopStore } from "../../state/desktop-store-context.tsx";
import { useSessionCache, useSessionCacheSnapshot } from "../../state/session-cache-context.tsx";

export const Route = createFileRoute("/_chat/projects/$projectId/session/$threadId")({
  beforeLoad: () => {
    // Intent preloading must remain side-effect free.
  },
  component: SessionRoute,
});

type ValidationState = "loading" | "ready" | "invalid";
type SessionCatalogStatus = "project-unavailable" | "threads-unloaded" | "thread-invalid" | "ready";

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

/** Validates catalog identity, then activates one cached record. */
function SessionRoute() {
  const { projectId, threadId } = Route.useParams();
  const store = useDesktopStore();
  const actions = useDesktopActions();
  const catalogStatus = useStore(store, (state) => selectSessionCatalogStatus(state, projectId, threadId));
  const catalogLoading = useStore(store, (state) => state.loading);
  const cache = useSessionCache();
  const snapshot = useSessionCacheSnapshot();
  const [validation, setValidation] = useState<ValidationState>("loading");

  useEffect(() => {
    if (catalogLoading) return;
    if (catalogStatus === "project-unavailable" || catalogStatus === "thread-invalid") {
      cache.setActiveKey(null);
      setValidation("invalid");
      return;
    }
    if (catalogStatus === "threads-unloaded") {
      setValidation("loading");
      void actions.loadProjectThreads(projectId).catch(() => setValidation("invalid"));
      return;
    }

    let current = true;
    setValidation("loading");
    void actions
      .activateProject(projectId)
      .then(() => {
        if (!current) return;
        const record = cache.ensure({ projectId, threadId });
        cache.setActiveKey(record.key);
        setValidation("ready");
      })
      .catch(() => {
        if (!current) return;
        cache.setActiveKey(null);
        setValidation("invalid");
      });
    return () => {
      current = false;
    };
  }, [actions, cache, catalogLoading, catalogStatus, projectId, threadId]);

  if (validation === "invalid") {
    return (
      <>
        <header className="topbar">
          <div className="topbar-title">
            <strong>无法打开会话</strong>
          </div>
        </header>
        <div className="workspace-row">
          <main className="chat-workspace">
            <div className="empty-chat-state">
              <strong>无法打开会话</strong>
            </div>
          </main>
        </div>
      </>
    );
  }

  const routeRecord = snapshot.records.find(
    (record) => record.identity.projectId === projectId && record.identity.threadId === threadId,
  );
  const activeKey = validation === "ready" && routeRecord?.key === snapshot.activeKey ? snapshot.activeKey : null;
  return <SessionCacheHost records={snapshot.records} activeKey={activeKey} />;
}
