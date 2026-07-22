import { Button } from "@renderer/shared/ui/button";
import { ConfirmDialog } from "@renderer/shared/ui/confirm-dialog";
import { Dialog } from "@renderer/shared/ui/dialog";
import { DialogClose } from "@renderer/shared/ui/dialog-close";
import { DialogContent } from "@renderer/shared/ui/dialog-content";
import { DialogDescription } from "@renderer/shared/ui/dialog-description";
import { DialogTitle } from "@renderer/shared/ui/dialog-title";
import { Input } from "@renderer/shared/ui/input";
import { useNavigate, useParams } from "@tanstack/react-router";
import { type FormEvent, useCallback, useMemo, useRef, useState } from "react";
import type { Project, Thread } from "../../../../shared/contracts.ts";
import { useDesktopActions } from "../../state/desktop-context.tsx";
import { useSessionCacheSnapshot } from "../../state/session-cache-context.tsx";
import {
  COLLAPSED_THREAD_COUNT,
  isThreadListExpanded,
  nextThreadVisibleLimit,
  normalizeThreadTitle,
  runPendingThreadAction,
  visibleThreadsByArchiveState,
} from "../../state/thread-list-commands.ts";
import { DesktopThreadListItem } from "./desktop-thread-list-item.tsx";

interface DesktopThreadListProps {
  project: Project;
  threads: readonly Thread[];
}

interface RenameState {
  threadId: string;
  title: string;
}

/** 使用 Router 导航渲染当前 Project 的 session 列表。 */
export function DesktopThreadList({ project, threads }: DesktopThreadListProps) {
  const actions = useDesktopActions();
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as Record<string, string | undefined>;
  const activeThreadId = params.projectId === project.id ? (params.threadId ?? null) : null;
  const { draftMaterializing: navigationDisabled } = useSessionCacheSnapshot();
  const pendingActions = useRef(new Set<string>());
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [renaming, setRenaming] = useState<RenameState | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Thread | null>(null);
  const [visibleLimit, setVisibleLimit] = useState(COLLAPSED_THREAD_COUNT);
  const regularThreadCount = useMemo(() => threads.filter(({ archived }) => !archived).length, [threads]);
  const visibleThreads = useMemo(
    () => visibleThreadsByArchiveState(threads, false, visibleLimit),
    [threads, visibleLimit],
  );
  const hasMoreThreads = regularThreadCount > visibleLimit;
  const isExpanded = isThreadListExpanded(visibleLimit, regularThreadCount);

  const runAction = useCallback((key: string, action: () => Promise<void>) => {
    void runPendingThreadAction(pendingActions.current, key, setPendingKeys, action).catch(() => undefined);
  }, []);

  const commitRename = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!renaming) return;
      const thread = threads.find(({ id }) => id === renaming.threadId);
      const title = normalizeThreadTitle(renaming.title);
      setRenaming(null);
      if (!thread || !title || title === thread.title) return;
      runAction(`rename:${thread.id}`, () => actions.renameThread(project.id, thread.id, title));
    },
    [actions, project.id, renaming, runAction, threads],
  );

  const confirmDelete = useCallback(() => {
    const thread = pendingDelete;
    if (!thread) return;
    setPendingDelete(null);
    runAction(`delete:${thread.id}`, () => actions.removeThread(project.id, thread.id));
  }, [actions, pendingDelete, project.id, runAction]);

  const openThread = useCallback(
    (thread: Thread) => {
      void navigate({
        to: "/projects/$projectId/session/$threadId",
        params: { projectId: project.id, threadId: thread.id },
      });
    },
    [navigate, project.id],
  );

  const prewarmThread = useCallback(
    (thread: Thread) => actions.prewarmThread(project.id, thread.id),
    [actions, project.id],
  );

  const startRename = useCallback((thread: Thread) => {
    setRenaming({ threadId: thread.id, title: thread.title });
  }, []);

  const archiveThread = useCallback(
    (thread: Thread, archived: boolean) => {
      runAction(`archive:${thread.id}`, () => actions.setThreadArchived(project.id, thread.id, archived));
    },
    [actions, project.id, runAction],
  );

  return (
    <div className="thread-list">
      {visibleThreads.map((thread) => (
        <DesktopThreadListItem
          key={thread.id}
          thread={thread}
          active={activeThreadId === thread.id}
          isSwitching={navigationDisabled || pendingKeys.has(`switch:${thread.id}`)}
          isRenamingPending={pendingKeys.has(`rename:${thread.id}`)}
          isArchivePending={pendingKeys.has(`archive:${thread.id}`)}
          isDeletePending={pendingKeys.has(`delete:${thread.id}`)}
          onRenameStart={startRename}
          onOpen={openThread}
          onArchive={archiveThread}
          onDelete={setPendingDelete}
          onPrewarm={prewarmThread}
        />
      ))}
      {hasMoreThreads || isExpanded ? (
        <div className="flex items-center gap-1 px-8 py-1">
          {hasMoreThreads ? (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-foreground active:text-foreground inline-block h-7 p-0 text-left font-normal hover:bg-transparent"
              onClick={() => setVisibleLimit((current) => nextThreadVisibleLimit(current, regularThreadCount))}
            >
              展开更多
            </Button>
          ) : null}
          {isExpanded ? (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-foreground active:text-foreground inline-block h-7 p-0 text-left font-normal hover:bg-transparent"
              onClick={() => setVisibleLimit(COLLAPSED_THREAD_COUNT)}
            >
              收起
            </Button>
          ) : null}
        </div>
      ) : null}
      <Dialog
        open={renaming !== null}
        onOpenChange={(open) => {
          if (!open) setRenaming(null);
        }}
      >
        <DialogContent className="gap-3 sm:max-w-md">
          <DialogTitle>重命名会话</DialogTitle>
          <DialogDescription>输入新的会话名称。</DialogDescription>
          <form className="mt-2 space-y-4" onSubmit={commitRename}>
            <Input
              autoFocus
              aria-label="会话名称"
              value={renaming?.title ?? ""}
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) =>
                setRenaming((current) => (current ? { ...current, title: event.target.value } : current))
              }
            />
            <div className="flex justify-end gap-2">
              <DialogClose asChild>
                <Button variant="ghost">取消</Button>
              </DialogClose>
              <Button type="submit" disabled={normalizeThreadTitle(renaming?.title ?? "") === null}>
                保存
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除会话"
        description={`永久删除 Pi 会话"${pendingDelete?.title ?? ""}"及其本地会话文件。`}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
