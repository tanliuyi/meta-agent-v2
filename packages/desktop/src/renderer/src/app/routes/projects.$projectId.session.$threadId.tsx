import { createFileRoute, useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useSessionCache } from "../../state/session-cache-context.tsx";

export const Route = createFileRoute("/projects/$projectId/session/$threadId")({
  beforeLoad: () => {
    // Intent preloading must remain side-effect free.
  },
  component: SessionRoute,
});

type ValidationState = "loading" | "ready" | "invalid";

/** Validates a committed URL before it becomes a cache/attachment target. */
function SessionRoute() {
  const params = useParams({ strict: false }) as Record<string, string | undefined>;
  const projectId = params.projectId;
  const threadId = params.threadId;
  const cache = useSessionCache();
  const [validation, setValidation] = useState<ValidationState>("loading");

  useEffect(() => {
    if (!projectId || !threadId) {
      setValidation("invalid");
      cache.setActiveKey(null);
      return;
    }
    let active = true;
    setValidation("loading");
    void Promise.all([window.desktop.projects.list(), window.desktop.sessions.list(projectId, true)])
      .then(async ([projects, threads]) => {
        if (!active) return;
        const project = projects.find((entry) => entry.id === projectId && entry.available);
        const thread = threads.find((entry) => entry.id === threadId);
        if (!project || !thread || thread.projectId !== projectId || thread.archived) {
          cache.setActiveKey(null);
          setValidation("invalid");
          return;
        }
        await window.desktop.projects.open(projectId);
        if (!active) return;
        const record = cache.ensure({ projectId, threadId });
        cache.setActiveKey(record.key);
        setValidation("ready");
      })
      .catch(() => {
        if (!active) return;
        cache.setActiveKey(null);
        setValidation("invalid");
      });
    return () => {
      active = false;
      cache.setActiveKey(null);
    };
  }, [cache, projectId, threadId]);

  if (validation === "invalid") {
    return (
      <main className="workspace">
        <div className="empty-chat-state">
          <strong>无法打开会话</strong>
        </div>
      </main>
    );
  }
  return null;
}
