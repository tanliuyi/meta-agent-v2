import { TooltipIconButton } from "@renderer/components/assistant-ui/tooltip-icon-button";
import { Button } from "@renderer/shared/ui/button";
import { ConfirmDialog } from "@renderer/shared/ui/confirm-dialog";
import { Dialog } from "@renderer/shared/ui/dialog";
import { DialogClose } from "@renderer/shared/ui/dialog-close";
import { DialogContent } from "@renderer/shared/ui/dialog-content";
import { DialogDescription } from "@renderer/shared/ui/dialog-description";
import { DialogFooter } from "@renderer/shared/ui/dialog-footer";
import { DialogTitle } from "@renderer/shared/ui/dialog-title";
import { useNavigate } from "@tanstack/react-router";
import Archive from "lucide-react/dist/esm/icons/archive.mjs";
import LoaderCircle from "lucide-react/dist/esm/icons/loader-circle.mjs";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.mjs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Project, SessionRemovePolicy, Thread } from "../../../../../shared/contracts.ts";
import { useDesktopActions, useDesktopSelector } from "../../../state/desktop-context.tsx";
import { selectProjects } from "../../../state/desktop-selectors.ts";
import { runPendingThreadAction, threadDescendantIds } from "../../../state/thread-list-commands.ts";
import { ArchivedSessionRow } from "./archived-session-row.tsx";

interface ArchivedProjectGroup {
  project: Project;
  /** 完整 catalog：删除树判定基于它。 */
  threads: readonly Thread[];
  archivedThreads: readonly Thread[];
}

/** 归档设置页：按项目分组展示已归档会话，支持恢复与删除。 */
export function ArchivesSettingsPage() {
  const actions = useDesktopActions();
  const navigate = useNavigate();
  const projects = useDesktopSelector(selectProjects);
  const threadCatalogs = useDesktopSelector((state) => state.threadCatalogs);
  const [failedProjectIds, setFailedProjectIds] = useState<ReadonlySet<string>>(() => new Set());
  const [retryNonce, setRetryNonce] = useState(0);
  const pendingActions = useRef(new Set<string>());
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [pendingDelete, setPendingDelete] = useState<Thread | null>(null);
  const [deleting, setDeleting] = useState(false);

  const needsLoad = useMemo(
    () =>
      projects.filter((project) => project.available && threadCatalogs[project.id] === undefined).map(({ id }) => id),
    [projects, threadCatalogs],
  );
  const waiting = needsLoad.some((id) => !failedProjectIds.has(id));
  const failedProjects = projects.filter(
    (project) => failedProjectIds.has(project.id) && threadCatalogs[project.id] === undefined,
  );

  useEffect(() => {
    let cancelled = false;
    setFailedProjectIds((current) => {
      let changed = false;
      const next = new Set(current);
      for (const id of next) {
        if (threadCatalogs[id] !== undefined) {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? next : current;
    });
    for (const projectId of needsLoad) {
      if (failedProjectIds.has(projectId)) continue;
      void actions.loadProjectThreads(projectId).catch(() => {
        if (cancelled) return;
        setFailedProjectIds((current) => (current.has(projectId) ? current : new Set(current).add(projectId)));
      });
    }
    return () => {
      cancelled = true;
    };
  }, [actions, failedProjectIds, needsLoad, retryNonce, threadCatalogs]);

  const groups = useMemo<ArchivedProjectGroup[]>(
    () =>
      projects.flatMap((project) => {
        const threads = threadCatalogs[project.id];
        if (!threads) return [];
        const archivedThreads = threads.filter((thread) => thread.archived);
        return archivedThreads.length > 0 ? [{ project, threads, archivedThreads }] : [];
      }),
    [projects, threadCatalogs],
  );

  const runAction = useCallback((key: string, action: () => Promise<void>) => {
    void runPendingThreadAction(pendingActions.current, key, setPendingKeys, action).catch(() => undefined);
  }, []);

  /** 点击标题：恢复（取消归档）后导航到该会话。 */
  const openThread = useCallback(
    (thread: Thread) => {
      runAction(`restore:${thread.id}`, async () => {
        await actions.setThreadArchived(thread.projectId, thread.id, false);
        await navigate({
          to: "/projects/$projectId/session/$threadId",
          params: { projectId: thread.projectId, threadId: thread.id },
        });
      });
    },
    [actions, navigate, runAction],
  );

  const restoreThread = useCallback(
    (thread: Thread) => {
      runAction(`restore:${thread.id}`, () => actions.setThreadArchived(thread.projectId, thread.id, false));
    },
    [actions, runAction],
  );

  const pendingDeleteDescendantIds = useMemo(() => {
    if (!pendingDelete) return [];
    const threads = threadCatalogs[pendingDelete.projectId] ?? [];
    return threadDescendantIds(threads, pendingDelete.id);
  }, [pendingDelete, threadCatalogs]);
  const pendingDeleteHasRunningDescendant = useMemo(() => {
    if (!pendingDelete) return false;
    const threads = threadCatalogs[pendingDelete.projectId] ?? [];
    const descendantIds = new Set(pendingDeleteDescendantIds);
    return threads.some((thread) => descendantIds.has(thread.id) && thread.running);
  }, [pendingDelete, pendingDeleteDescendantIds, threadCatalogs]);

  const confirmDelete = useCallback(
    async (policy: SessionRemovePolicy) => {
      const thread = pendingDelete;
      if (!thread) return;
      setDeleting(true);
      try {
        await runPendingThreadAction(pendingActions.current, `delete:${thread.id}`, setPendingKeys, () =>
          actions.removeThread(thread.projectId, thread.id, policy),
        );
        setPendingDelete(null);
      } finally {
        setDeleting(false);
      }
    },
    [actions, pendingDelete],
  );

  return (
    <div className="settings-content">
      <header className="settings-page-heading">
        <div>
          <h2>归档</h2>
          <p>已归档的会话不会出现在侧边栏，可在此按项目查看、恢复或删除</p>
        </div>
        {failedProjects.length > 0 ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setRetryNonce((nonce) => nonce + 1);
              setFailedProjectIds(new Set());
            }}
          >
            <RefreshCw />
            重试
          </Button>
        ) : null}
      </header>

      {failedProjects.length > 0 ? (
        <div className="settings-page-message" data-tone="error" role="alert">
          {failedProjects.map((project) => project.name).join("、")} 的会话列表加载失败，可重试
        </div>
      ) : null}

      {waiting ? (
        <div className="flex h-16 items-center gap-2 px-2 text-sm text-muted-foreground" role="status">
          <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
          <span>加载归档会话</span>
        </div>
      ) : null}

      {!waiting && groups.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-2 py-12 text-center">
          <Archive className="text-muted-foreground/60 size-8" aria-hidden="true" />
          <p className="text-sm text-muted-foreground">没有归档会话</p>
        </div>
      ) : null}

      {groups.map(({ project, threads, archivedThreads }) => (
        <section key={project.id} className="settings-section" aria-labelledby={`archive-project-${project.id}`}>
          <div className="settings-section-heading">
            <h3 id={`archive-project-${project.id}`}>{project.name}</h3>
            <span className="text-xs text-muted-foreground">{archivedThreads.length} 个会话</span>
          </div>
          <ul className="archived-session-list">
            {archivedThreads.map((thread) => (
              <ArchivedSessionRow
                key={thread.id}
                thread={thread}
                pending={pendingKeys.has(`restore:${thread.id}`) || pendingKeys.has(`delete:${thread.id}`)}
                onOpen={openThread}
                onRestore={restoreThread}
                onDelete={setPendingDelete}
              />
            ))}
          </ul>
        </section>
      ))}

      <ConfirmDialog
        open={pendingDelete !== null && pendingDeleteDescendantIds.length === 0}
        title="删除会话"
        description={`永久删除“${pendingDelete?.title ?? "该会话"}”及其本地会话文件。`}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        onConfirm={() => confirmDelete("subtree")}
      />
      <Dialog
        open={pendingDelete !== null && pendingDeleteDescendantIds.length > 0}
        onOpenChange={(open) => {
          if (!open && !deleting) setPendingDelete(null);
        }}
      >
        <DialogContent className="gap-3 sm:max-w-lg">
          <DialogTitle>删除会话树</DialogTitle>
          <DialogDescription>
            {pendingDeleteHasRunningDescendant
              ? `该会话包含 ${pendingDeleteDescendantIds.length} 个后代会话，其中仍有会话正在运行。请先停止相关任务。`
              : `该会话包含 ${pendingDeleteDescendantIds.length} 个后代会话。可以保留并提升后代，或永久删除整棵会话树。`}
          </DialogDescription>
          <DialogFooter variant="actions" className="flex-wrap">
            <DialogClose asChild>
              <Button variant="ghost">取消</Button>
            </DialogClose>
            <Button
              variant="outline"
              disabled={pendingDeleteHasRunningDescendant || deleting}
              onClick={() => void confirmDelete("reparent").catch(() => undefined)}
            >
              保留并提升子会话
            </Button>
            <Button
              variant="destructive"
              disabled={pendingDeleteHasRunningDescendant || deleting}
              onClick={() => void confirmDelete("subtree").catch(() => undefined)}
            >
              {deleting ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : null}
              删除全部 {pendingDeleteDescendantIds.length + 1} 个会话
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
