import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useStore } from "zustand";
import { SidebarToggle } from "../../components/layout/sidebar-toggle.tsx";
import { SessionCacheHost } from "../../components/session-cache-host.tsx";
import { SessionRoutePending } from "../../components/session-route-pending.tsx";
import { useDesktopActions } from "../../state/desktop-context.tsx";
import { selectSessionCatalogStatus } from "../../state/desktop-selectors.ts";
import { dispatchDesktop } from "../../state/desktop-store.ts";
import { useDesktopStore } from "../../state/desktop-store-context.tsx";
import {
  useSessionCache,
  useSessionCacheActiveKey,
  useSessionCacheRecords,
} from "../../state/session-cache-context.tsx";

export const Route = createFileRoute("/_chat/projects/$projectId/session/$threadId")({
  beforeLoad: () => {
    // Intent preloading must remain side-effect free.
  },
  component: SessionRoute,
});

type ValidationState = "loading" | "ready" | "invalid";

/** Validates catalog identity, then activates one cached record. */
function SessionRoute() {
  const { projectId, threadId } = Route.useParams();
  const store = useDesktopStore();
  const actions = useDesktopActions();
  const catalogStatus = useStore(store, (state) => selectSessionCatalogStatus(state, projectId, threadId));
  const catalogLoading = useStore(store, (state) => state.loading);
  const cache = useSessionCache();
  const records = useSessionCacheRecords();
  const cacheActiveKey = useSessionCacheActiveKey();
  const [validation, setValidation] = useState<ValidationState>("loading");
  const viewedCompleted = useStore(
    store,
    (state) =>
      state.threadCatalogs[projectId]?.some(({ id, completed }) => id === threadId && completed === true) === true,
  );

  // 打开会话即视为已查看：清除运行完成标记，并覆盖“正在查看时运行结束”的竞态。
  useEffect(() => {
    if (!viewedCompleted) return;
    dispatchDesktop(store, { type: "thread-viewed", projectId, threadId });
  }, [projectId, store, threadId, viewedCompleted]);

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
    cache.activate({ projectId, threadId });
    const record = cache.ensure({ projectId, threadId });
    setValidation("ready");
    void actions.activateProject(projectId).catch(() => {
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
          <SidebarToggle location="topbar" />
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

  const routeRecord = records.find(
    (record) => record.identity.projectId === projectId && record.identity.threadId === threadId,
  );
  const activeKey = validation === "ready" && routeRecord?.key === cacheActiveKey ? cacheActiveKey : null;
  return activeKey ? <SessionCacheHost records={records} activeKey={activeKey} /> : <SessionRoutePending />;
}
