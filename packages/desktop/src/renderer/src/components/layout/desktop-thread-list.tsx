import { useAssistantRuntime, useAuiState } from "@assistant-ui/react";
import { Button } from "@renderer/shared/ui/button";
import { ConfirmDialog } from "@renderer/shared/ui/confirm-dialog";
import { Dialog } from "@renderer/shared/ui/dialog";
import { DialogClose } from "@renderer/shared/ui/dialog-close";
import { DialogContent } from "@renderer/shared/ui/dialog-content";
import { DialogDescription } from "@renderer/shared/ui/dialog-description";
import { DialogTitle } from "@renderer/shared/ui/dialog-title";
import { Input } from "@renderer/shared/ui/input";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right.mjs";
import { type FormEvent, useCallback, useMemo, useRef, useState } from "react";
import type { Project, Thread } from "../../../../shared/contracts.ts";
import { threadAdapterId } from "../../runtime/thread-adapter.ts";
import { useDesktopActions, useDesktopSelector } from "../../state/desktop-context.tsx";
import {
  selectHasDraft,
  selectIsDraftMaterializing,
  selectNavigationThreadIdForProject,
} from "../../state/desktop-selectors.ts";
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

/** 使用 assistant-ui primitives 渲染当前 Project 的 session 列表。 */
export function DesktopThreadList({ project, threads }: DesktopThreadListProps) {
  const actions = useDesktopActions();
  const assistantRuntime = useAssistantRuntime();
  const activeThreadId = useDesktopSelector((state) => selectNavigationThreadIdForProject(state, project.id));
  const hasDraft = useDesktopSelector(selectHasDraft);
  const navigationDisabled = useDesktopSelector(selectIsDraftMaterializing);
  const pendingActions = useRef(new Set<string>());
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [renaming, setRenaming] = useState<RenameState | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Thread | null>(null);
  const [pendingOpen, setPendingOpen] = useState<Thread | null>(null);
  const [visibleLimit, setVisibleLimit] = useState(COLLAPSED_THREAD_COUNT);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [archivedVisibleLimit, setArchivedVisibleLimit] = useState(COLLAPSED_THREAD_COUNT);
  const composerIsEmpty = useAuiState((state) => state.composer.isEmpty);
  const runtimeThreadIds = useAuiState((state) => state.threads.threadIds);
  const runtimeArchivedThreadIds = useAuiState((state) => state.threads.archivedThreadIds);
  const availableRuntimeThreadIds = useMemo(
    () => new Set([...runtimeThreadIds, ...runtimeArchivedThreadIds]),
    [runtimeArchivedThreadIds, runtimeThreadIds],
  );
  const regularThreadCount = useMemo(() => threads.filter(({ archived }) => !archived).length, [threads]);
  const archivedThreadCount = threads.length - regularThreadCount;
  const visibleThreads = useMemo(
    () => visibleThreadsByArchiveState(threads, false, visibleLimit),
    [threads, visibleLimit],
  );
  const visibleArchivedThreads = useMemo(
    () => (archivedOpen ? visibleThreadsByArchiveState(threads, true, archivedVisibleLimit) : []),
    [archivedOpen, archivedVisibleLimit, threads],
  );
  const renderedThreads = useMemo(
    () =>
      visibleThreads.flatMap((thread) => {
        const adapterId = threadAdapterId(project.id, thread.id);
        if (!availableRuntimeThreadIds.has(adapterId)) return [];
        return [{ runtime: assistantRuntime.threads.getItemById(adapterId), thread }];
      }),
    [assistantRuntime.threads, availableRuntimeThreadIds, project.id, visibleThreads],
  );
  const renderedArchivedThreads = useMemo(
    () =>
      visibleArchivedThreads.flatMap((thread) => {
        const adapterId = threadAdapterId(project.id, thread.id);
        if (!availableRuntimeThreadIds.has(adapterId)) return [];
        return [{ runtime: assistantRuntime.threads.getItemById(adapterId), thread }];
      }),
    [assistantRuntime.threads, availableRuntimeThreadIds, project.id, visibleArchivedThreads],
  );
  const hasMoreThreads = regularThreadCount > visibleLimit;
  const isExpanded = isThreadListExpanded(visibleLimit, regularThreadCount);
  const hasMoreArchivedThreads = archivedThreadCount > archivedVisibleLimit;
  const isArchivedExpanded = isThreadListExpanded(archivedVisibleLimit, archivedThreadCount);

  const runAction = useCallback((key: string, action: () => Promise<void>) => {
    void runPendingThreadAction(pendingActions.current, key, setPendingKeys, action);
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
      if (hasDraft && !composerIsEmpty) {
        setPendingOpen(thread);
        return;
      }
      runAction(`switch:${thread.id}`, () => actions.openThread(project.id, thread.id));
    },
    [actions, composerIsEmpty, hasDraft, project.id, runAction],
  );

  const confirmOpen = useCallback(() => {
    const thread = pendingOpen;
    if (!thread) return;
    setPendingOpen(null);
    runAction(`switch:${thread.id}`, () => actions.openThread(project.id, thread.id));
  }, [actions, pendingOpen, project.id, runAction]);

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
    <div className="thread-list" data-slot="aui_thread-list-items">
      {renderedThreads.map(({ runtime, thread }) => (
        <DesktopThreadListItem
          key={thread.id}
          runtime={runtime}
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
      {archivedThreadCount > 0 ? (
        <>
          <button
            type="button"
            className="archive-toggle group"
            aria-expanded={archivedOpen}
            data-state={archivedOpen ? "open" : "closed"}
            onClick={() => setArchivedOpen((open) => !open)}
          >
            <ChevronRight
              size={12}
              aria-hidden="true"
              className="transition-transform group-data-[state=open]:rotate-90"
            />
            <span>已归档</span>
            <small>{archivedThreadCount}</small>
          </button>
          {renderedArchivedThreads.map(({ runtime, thread }) => (
            <DesktopThreadListItem
              key={thread.id}
              runtime={runtime}
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
            />
          ))}
          {archivedOpen && (hasMoreArchivedThreads || isArchivedExpanded) ? (
            <div className="flex items-center gap-1 px-8 py-1">
              {hasMoreArchivedThreads ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground hover:text-foreground active:text-foreground inline-block h-7 p-0 text-left font-normal hover:bg-transparent"
                  onClick={() =>
                    setArchivedVisibleLimit((current) => nextThreadVisibleLimit(current, archivedThreadCount))
                  }
                >
                  展开更多归档会话
                </Button>
              ) : null}
              {isArchivedExpanded ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground hover:text-foreground active:text-foreground inline-block h-7 p-0 text-left font-normal hover:bg-transparent"
                  onClick={() => setArchivedVisibleLimit(COLLAPSED_THREAD_COUNT)}
                >
                  收起归档会话
                </Button>
              ) : null}
            </div>
          ) : null}
        </>
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
        description={`永久删除 Pi 会话“${pendingDelete?.title ?? ""}”及其本地会话文件。`}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        onConfirm={confirmDelete}
      />
      <ConfirmDialog
        open={pendingOpen !== null}
        title="丢弃新会话草稿"
        description="当前输入尚未发送，打开其他会话会丢弃这些内容。"
        confirmLabel="丢弃并打开"
        onOpenChange={(open) => {
          if (!open) setPendingOpen(null);
        }}
        onConfirm={confirmOpen}
      />
    </div>
  );
}
