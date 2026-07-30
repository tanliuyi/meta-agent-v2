import { Button } from "@renderer/shared/ui/button";
import { ConfirmDialog } from "@renderer/shared/ui/confirm-dialog";
import { Dialog } from "@renderer/shared/ui/dialog";
import { DialogClose } from "@renderer/shared/ui/dialog-close";
import { DialogContent } from "@renderer/shared/ui/dialog-content";
import { DialogDescription } from "@renderer/shared/ui/dialog-description";
import { DialogFooter } from "@renderer/shared/ui/dialog-footer";
import { DialogTitle } from "@renderer/shared/ui/dialog-title";
import { Input } from "@renderer/shared/ui/input";
import { useNavigate, useParams } from "@tanstack/react-router";
import { type FormEvent, Fragment, useCallback, useMemo, useRef, useState } from "react";
import type { Project, SessionRemovePolicy, Thread } from "../../../../shared/contracts.ts";
import { useDesktopActions } from "../../state/desktop-context.tsx";
import { useSessionDraftMaterializing } from "../../state/session-cache-context.tsx";
import {
  COLLAPSED_THREAD_COUNT,
  flattenVisibleThreadTree,
  isThreadListExpanded,
  nextThreadVisibleLimit,
  normalizeThreadTitle,
  runPendingThreadAction,
  threadDescendantIds,
  threadTreeByArchiveState,
} from "../../state/thread-list-commands.ts";
import { DesktopThreadListItem } from "./desktop-thread-list-item.tsx";
import { ThreadListToggle } from "./thread-list-toggle.tsx";

interface DesktopThreadListProps {
  project: Project;
  threads: readonly Thread[];
  compactRoot?: boolean;
}

interface RenameState {
  threadId: string;
  title: string;
}

/** 使用 Router 导航渲染当前 Project 的 session 列表。 */
export function DesktopThreadList({ project, threads, compactRoot = false }: DesktopThreadListProps) {
  const actions = useDesktopActions();
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as Record<string, string | undefined>;
  const activeThreadId = params.projectId === project.id ? (params.threadId ?? null) : null;
  const navigationDisabled = useSessionDraftMaterializing();
  const pendingActions = useRef(new Set<string>());
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [renaming, setRenaming] = useState<RenameState | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Thread | null>(null);
  const pendingDeleteDescendantIds = useMemo(
    () => (pendingDelete ? threadDescendantIds(threads, pendingDelete.id) : []),
    [pendingDelete, threads],
  );
  const pendingDeleteHasRunningDescendant = useMemo(() => {
    const descendantIds = new Set(pendingDeleteDescendantIds);
    return threads.some((thread) => descendantIds.has(thread.id) && thread.running);
  }, [pendingDeleteDescendantIds, threads]);
  const [visibleLimit, setVisibleLimit] = useState(COLLAPSED_THREAD_COUNT);
  const threadTree = useMemo(() => threadTreeByArchiveState(threads, false, Number.MAX_SAFE_INTEGER), [threads]);
  const [expandedThreadIds, setExpandedThreadIds] = useState<ReadonlySet<string>>(() => new Set());
  const [childVisibleLimits, setChildVisibleLimits] = useState<ReadonlyMap<string, number>>(() => new Map());
  const regularThreadCount = threadTree.length;
  const visibleThreadTree = useMemo(() => threadTree.slice(0, visibleLimit), [threadTree, visibleLimit]);
  const visibleThreads = useMemo(
    () => flattenVisibleThreadTree(visibleThreadTree, expandedThreadIds, childVisibleLimits),
    [childVisibleLimits, expandedThreadIds, visibleThreadTree],
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

  const confirmDelete = useCallback(
    (policy: SessionRemovePolicy) => {
      const thread = pendingDelete;
      if (!thread) return;
      setPendingDelete(null);
      runAction(`delete:${thread.id}`, () => actions.removeThread(project.id, thread.id, policy));
    },
    [actions, pendingDelete, project.id, runAction],
  );

  const openThread = useCallback(
    (thread: Thread) => {
      void navigate({
        to: "/projects/$projectId/session/$threadId",
        params: { projectId: project.id, threadId: thread.id },
      });
    },
    [navigate, project.id],
  );

  const toggleThread = useCallback((threadId: string) => {
    setExpandedThreadIds((current) => {
      const next = new Set(current);
      if (next.has(threadId)) next.delete(threadId);
      else next.add(threadId);
      return next;
    });
  }, []);

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
    <div className="thread-list mb-1" role="tree" aria-label={`${project.name} 会话`}>
      {visibleThreads.map(
        ({
          thread,
          depth,
          childCount,
          runningChildCount,
          expanded,
          ancestorContinuations,
          isLastChild,
          siblingExpansions,
        }) => (
          <Fragment key={thread.id}>
            <DesktopThreadListItem
              thread={thread}
              active={activeThreadId === thread.id}
              isSwitching={navigationDisabled || pendingKeys.has(`switch:${thread.id}`)}
              isRenamingPending={pendingKeys.has(`rename:${thread.id}`)}
              isArchivePending={pendingKeys.has(`archive:${thread.id}`)}
              isDeletePending={pendingKeys.has(`delete:${thread.id}`)}
              depth={depth}
              childCount={childCount}
              runningChildCount={runningChildCount}
              expanded={expanded}
              ancestorContinuations={ancestorContinuations}
              isLastChild={isLastChild}
              compactRoot={compactRoot}
              onToggle={toggleThread}
              onRenameStart={startRename}
              onOpen={openThread}
              onArchive={archiveThread}
              onDelete={setPendingDelete}
            />
            {siblingExpansions?.map((siblingExpansion) => (
              <div
                key={siblingExpansion.parentThreadId}
                className="flex items-center gap-2"
                style={{ paddingInlineStart: 32 + siblingExpansion.depth * 14 }}
              >
                {siblingExpansion.hasMore ? (
                  <ThreadListToggle
                    onClick={() =>
                      setChildVisibleLimits((current) => {
                        const next = new Map(current);
                        next.set(
                          siblingExpansion.parentThreadId,
                          nextThreadVisibleLimit(
                            current.get(siblingExpansion.parentThreadId) ?? COLLAPSED_THREAD_COUNT,
                            siblingExpansion.threadCount,
                          ),
                        );
                        return next;
                      })
                    }
                  >
                    展开更多
                  </ThreadListToggle>
                ) : null}
                {siblingExpansion.expanded ? (
                  <ThreadListToggle
                    onClick={() =>
                      setChildVisibleLimits((current) => {
                        const next = new Map(current);
                        next.set(siblingExpansion.parentThreadId, COLLAPSED_THREAD_COUNT);
                        return next;
                      })
                    }
                  >
                    收起
                  </ThreadListToggle>
                ) : null}
              </div>
            ))}
          </Fragment>
        ),
      )}
      {hasMoreThreads || isExpanded ? (
        <div className="flex items-center gap-2" style={{ paddingInlineStart: compactRoot ? 8 : 32 }}>
          {hasMoreThreads ? (
            <ThreadListToggle
              onClick={() => setVisibleLimit((current) => nextThreadVisibleLimit(current, regularThreadCount))}
            >
              展开更多
            </ThreadListToggle>
          ) : null}
          {isExpanded ? (
            <ThreadListToggle onClick={() => setVisibleLimit(COLLAPSED_THREAD_COUNT)}>收起</ThreadListToggle>
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
        open={pendingDelete !== null && pendingDeleteDescendantIds.length === 0}
        title="删除会话"
        description="永久删除此会话及其本地会话文件。"
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        onConfirm={() => confirmDelete("subtree")}
      />
      <Dialog
        open={pendingDelete !== null && pendingDeleteDescendantIds.length > 0}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
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
              disabled={pendingDeleteHasRunningDescendant}
              onClick={() => confirmDelete("reparent")}
            >
              保留并提升子会话
            </Button>
            <Button
              variant="destructive"
              disabled={pendingDeleteHasRunningDescendant}
              onClick={() => confirmDelete("subtree")}
            >
              删除全部 {pendingDeleteDescendantIds.length + 1} 个会话
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
