import { ThreadListItemPrimitive, ThreadListPrimitive, useAuiState } from "@assistant-ui/react";
import { Archive, ArchiveRestore, Trash2 } from "lucide-react";
import { ContextMenu } from "radix-ui";
import { type KeyboardEvent, useMemo, useRef, useState } from "react";
import type { Project, Thread } from "../../../../shared/contracts.ts";
import { useDesktopNavigation } from "../../state/desktop-context.tsx";
import {
  COLLAPSED_THREAD_COUNT,
  isDesktopThreadItemForProject,
  nextThreadVisibleLimit,
  normalizeThreadTitle,
  preventPrimitiveThreadAction,
  resolveDesktopThreadItem,
  runControlledThreadAction,
  runPendingThreadAction,
  shouldOpenThread,
  type ThreadListItemIdentity,
  visibleRegularThreadIds,
} from "../../state/thread-list-commands.ts";
import { Button } from "../ui/button.tsx";
import { ConfirmDialog } from "../ui/confirm-dialog.tsx";

interface DesktopThreadListProps {
  id: string;
  project: Project;
}

interface RenameState {
  threadId: string;
  title: string;
}

/** 使用 assistant-ui primitives 渲染当前 Project 的 session 列表。 */
export function DesktopThreadList({ id, project }: DesktopThreadListProps) {
  const desktop = useDesktopNavigation();
  const pendingActions = useRef(new Set<string>());
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [renaming, setRenaming] = useState<RenameState | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Thread | null>(null);
  const [pendingOpen, setPendingOpen] = useState<Thread | null>(null);
  const [visibleLimit, setVisibleLimit] = useState(COLLAPSED_THREAD_COUNT);
  const composerIsEmpty = useAuiState((state) => state.composer.isEmpty);
  const navigationDisabled = desktop.draft?.phase === "materializing";
  const threads = desktop.threadCatalogs[project.id] ?? [];
  const regularThreadCount = threads.filter(({ archived }) => !archived).length;
  const visibleThreadIds = useMemo(() => visibleRegularThreadIds(threads, visibleLimit), [threads, visibleLimit]);
  const hasMoreThreads = regularThreadCount > visibleLimit;
  const isExpanded = visibleLimit > COLLAPSED_THREAD_COUNT;

  const runAction = (key: string, action: () => Promise<void>) => {
    void runPendingThreadAction(pendingActions.current, key, setPendingKeys, action);
  };

  const commitRename = (thread: Thread) => {
    if (renaming?.threadId !== thread.id) return;
    const title = normalizeThreadTitle(renaming.title);
    setRenaming(null);
    if (!title || title === thread.title) return;
    runAction(`rename:${thread.id}`, () => desktop.renameThread(project.id, thread.id, title));
  };

  const confirmDelete = () => {
    const thread = pendingDelete;
    if (!thread) return;
    setPendingDelete(null);
    runAction(`delete:${thread.id}`, () => desktop.removeThread(project.id, thread.id));
  };

  const openThread = (thread: Thread) => {
    if (desktop.draft && !composerIsEmpty) {
      setPendingOpen(thread);
      return;
    }
    runAction(`switch:${thread.id}`, () => desktop.openThread(project.id, thread.id));
  };

  const confirmOpen = () => {
    const thread = pendingOpen;
    if (!thread) return;
    setPendingOpen(null);
    runAction(`switch:${thread.id}`, () => desktop.openThread(project.id, thread.id));
  };

  const renderThreadItem = ({ threadListItem }: { threadListItem: ThreadListItemIdentity }) => (
    <DesktopThreadListItem
      item={threadListItem}
      project={project}
      threads={threads}
      visibleThreadIds={visibleThreadIds}
      activeThreadId={desktop.navigationProjectId === project.id ? desktop.navigationThreadId : null}
      renaming={renaming}
      pendingKeys={pendingKeys}
      navigationDisabled={navigationDisabled}
      onTitleChange={(title) => setRenaming((current) => (current ? { ...current, title } : current))}
      onRenameStart={(thread) => setRenaming({ threadId: thread.id, title: thread.title })}
      onRenameCancel={() => setRenaming(null)}
      onRenameCommit={commitRename}
      onOpen={openThread}
      onArchive={(thread, archived) =>
        runAction(`archive:${thread.id}`, () => desktop.setThreadArchived(project.id, thread.id, archived))
      }
      onDelete={setPendingDelete}
    />
  );

  return (
    <div id={id} className="thread-list" data-slot="aui_thread-list-items">
      <ThreadListPrimitive.Items>{renderThreadItem}</ThreadListPrimitive.Items>
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

interface DesktopThreadListItemProps {
  item: ThreadListItemIdentity;
  project: Project;
  threads: readonly Thread[];
  visibleThreadIds: ReadonlySet<string>;
  activeThreadId: string | null;
  renaming: RenameState | null;
  pendingKeys: ReadonlySet<string>;
  navigationDisabled: boolean;
  onTitleChange(title: string): void;
  onRenameStart(thread: Thread): void;
  onRenameCancel(): void;
  onRenameCommit(thread: Thread): void;
  onOpen(thread: Thread): void;
  onArchive(thread: Thread, archived: boolean): void;
  onDelete(thread: Thread): void;
}

function DesktopThreadListItem(props: DesktopThreadListItemProps) {
  if (!isDesktopThreadItemForProject(props.item, props.project.id)) return null;
  const thread = resolveDesktopThreadItem(props.item, props.project.id, props.threads);
  if (!thread || !props.visibleThreadIds.has(thread.id)) return null;
  const isRenaming = props.renaming?.threadId === thread.id;
  const isSwitching = props.navigationDisabled || props.pendingKeys.has(`switch:${thread.id}`);
  const isRenamingPending = props.pendingKeys.has(`rename:${thread.id}`);
  const isArchivePending = props.pendingKeys.has(`archive:${thread.id}`);
  const isDeletePending = props.pendingKeys.has(`delete:${thread.id}`);
  const isPending = isSwitching || isRenamingPending || isArchivePending || isDeletePending;

  const handleRenameKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      props.onRenameCommit(thread);
    } else if (event.key === "Escape") {
      event.preventDefault();
      props.onRenameCancel();
    }
  };

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild disabled={isRenaming}>
        <ThreadListItemPrimitive.Root
          data-slot="aui_thread-list-item"
          className="thread-row group hover:bg-muted focus-visible:bg-muted data-active:bg-foreground/10 data-active:hover:bg-foreground/10 has-focus-visible:bg-muted data-[state=open]:bg-muted relative flex h-8 items-center rounded-md transition-colors focus-visible:outline-none"
          data-thread-id={thread.id}
          data-pending={isPending || undefined}
        >
          {isRenaming ? (
            <input
              autoFocus
              value={props.renaming?.title ?? ""}
              disabled={isRenamingPending}
              className="border-input bg-background focus-visible:ring-ring/50 h-8 min-w-0 flex-1 rounded-md border px-2.5 text-sm outline-none focus-visible:ring-[3px]"
              onChange={(event) => props.onTitleChange(event.target.value)}
              onBlur={() => props.onRenameCommit(thread)}
              onKeyDown={handleRenameKeyDown}
            />
          ) : (
            <ThreadListItemPrimitive.Trigger
              data-slot="aui_thread-list-item-trigger"
              className="thread-main focus-visible:ring-ring/50 flex h-full min-w-0 flex-1 items-center rounded-md ps-8 pe-2 text-start text-sm outline-none focus-visible:ring-[3px]"
              disabled={isSwitching}
              onClickCapture={preventPrimitiveThreadAction}
              onClick={(event) =>
                runControlledThreadAction(event, () => {
                  if (shouldOpenThread(props.activeThreadId, thread.id)) props.onOpen(thread);
                })
              }
            >
              <span data-slot="aui_thread-list-item-title" className="min-w-0 flex-1 truncate">
                <ThreadListItemPrimitive.Title fallback="新会话" />
              </span>
              {thread.running ? <span className="running-dot" aria-label="运行中" /> : null}
            </ThreadListItemPrimitive.Trigger>
          )}
        </ThreadListItemPrimitive.Root>
      </ContextMenu.Trigger>
      {isRenaming ? null : (
        <ContextMenu.Portal>
          <ContextMenu.Content
            data-slot="aui_thread-list-item-context-menu"
            className="bg-popover/95 text-popover-foreground data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:animate-out z-50 min-w-32 overflow-hidden rounded-xl border p-1.5 shadow-lg backdrop-blur-sm"
          >
            <ContextMenu.Item
              data-slot="aui_thread-list-item-context-menu-item"
              className="hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none"
              onSelect={() => props.onRenameStart(thread)}
            >
              重命名
            </ContextMenu.Item>
            {thread.archived ? (
              <ThreadListItemPrimitive.Unarchive asChild disabled={isArchivePending}>
                <ContextMenu.Item
                  data-slot="aui_thread-list-item-context-menu-item"
                  className="hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none"
                  onClickCapture={preventPrimitiveThreadAction}
                  onClick={(event) => runControlledThreadAction(event, () => props.onArchive(thread, false))}
                >
                  <ArchiveRestore size={14} /> 恢复
                </ContextMenu.Item>
              </ThreadListItemPrimitive.Unarchive>
            ) : (
              <ThreadListItemPrimitive.Archive asChild disabled={isArchivePending}>
                <ContextMenu.Item
                  data-slot="aui_thread-list-item-context-menu-item"
                  className="hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none"
                  onClickCapture={preventPrimitiveThreadAction}
                  onClick={(event) => runControlledThreadAction(event, () => props.onArchive(thread, true))}
                >
                  <Archive size={14} /> 归档
                </ContextMenu.Item>
              </ThreadListItemPrimitive.Archive>
            )}
            <ThreadListItemPrimitive.Delete asChild disabled={isDeletePending}>
              <ContextMenu.Item
                data-slot="aui_thread-list-item-context-menu-item"
                className="text-destructive hover:bg-destructive/10 hover:text-destructive focus:bg-destructive/10 focus:text-destructive flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none"
                onClickCapture={preventPrimitiveThreadAction}
                onClick={(event) => runControlledThreadAction(event, () => props.onDelete(thread))}
              >
                <Trash2 size={14} /> 删除
              </ContextMenu.Item>
            </ThreadListItemPrimitive.Delete>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      )}
    </ContextMenu.Root>
  );
}
