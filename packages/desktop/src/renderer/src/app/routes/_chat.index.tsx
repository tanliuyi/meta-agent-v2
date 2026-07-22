import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useStore } from "zustand";
import { useDesktopStore } from "../../state/desktop-store-context.tsx";
import { useDraftSession } from "../../state/draft-session-context.tsx";
import { draftSearch } from "../../state/session-navigation.ts";

export const Route = createFileRoute("/_chat/")({ component: RootRedirect });

/** Resolves the root from the already loaded window catalog. */
function RootRedirect() {
  const navigate = useNavigate();
  const store = useDesktopStore();
  const draftProjectId = useDraftSession().projectId;
  const projects = useStore(store, (state) => state.projects);
  const activeProjectId = useStore(store, (state) => state.activeProjectId);
  const loading = useStore(store, (state) => state.loading);

  useEffect(() => {
    if (loading) return;
    const project =
      projects.find(({ id, available }) => id === draftProjectId && available) ??
      projects.find(({ id, available }) => id === activeProjectId && available) ??
      projects.find(({ available }) => available);
    void navigate({ to: "/new", search: draftSearch(project?.id), replace: true });
  }, [activeProjectId, draftProjectId, loading, navigate, projects]);
  return null;
}
