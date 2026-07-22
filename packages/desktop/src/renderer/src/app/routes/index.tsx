import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

export const Route = createFileRoute("/")({ component: RootRedirect });

/** Resolves the root URL without treating stale renderer selection as navigation state. */
function RootRedirect() {
  const navigate = useNavigate();
  useEffect(() => {
    let active = true;
    void (async () => {
      const [projects, current] = await Promise.all([
        window.desktop.projects.list(),
        window.desktop.projects.getActive(),
      ]);
      if (!active) return;
      const candidates = [current, ...projects].filter(
        (project, index, entries): project is NonNullable<typeof project> =>
          Boolean(project?.available) && entries.findIndex((entry) => entry?.id === project?.id) === index,
      );
      for (const project of candidates) {
        const thread = (await window.desktop.sessions.list(project.id)).find((entry) => !entry.archived);
        if (!active) return;
        if (thread) {
          await navigate({
            to: "/projects/$projectId/session/$threadId",
            params: { projectId: project.id, threadId: thread.id },
            replace: true,
          });
          return;
        }
      }
      const project = projects.find((entry) => entry.available);
      await navigate({ to: "/new", search: project ? { projectId: project.id } : undefined, replace: true });
    })().catch(() => undefined);
    return () => {
      active = false;
    };
  }, [navigate]);
  return null;
}
