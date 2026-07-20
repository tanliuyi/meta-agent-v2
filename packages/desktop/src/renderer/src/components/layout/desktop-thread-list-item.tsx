import { ThreadListItemPrimitive } from "@assistant-ui/react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import Archive from "lucide-react/dist/esm/icons/archive.mjs";
import Pencil from "lucide-react/dist/esm/icons/pencil.mjs";
import Trash2 from "lucide-react/dist/esm/icons/trash-2.mjs";
import { memo } from "react";
import type { Thread } from "../../../../shared/contracts.ts";
import { preventPrimitiveThreadAction, runControlledThreadAction } from "../../state/thread-list-commands.ts";

interface DesktopThreadListItemProps {
  thread: Thread;
  active: boolean;
  isSwitching: boolean;
  isRenamingPending: boolean;
  isArchivePending: boolean;
  isDeletePending: boolean;
  onRenameStart(thread: Thread): void;
  onOpen(thread: Thread): void;
  onArchive(thread: Thread, archived: boolean): void;
  onDelete(thread: Thread): void;
}

/** 在官方 ThreadListPrimitive.Items context 下渲染单个 session。 */
export const DesktopThreadListItem = memo(function DesktopThreadListItem(props: DesktopThreadListItemProps) {
  const { thread } = props;
  const isPending = props.isSwitching || props.isRenamingPending || props.isArchivePending || props.isDeletePending;

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <ThreadListItemPrimitive.Root
          data-slot="aui_thread-list-item"
          className="thread-row group hover:bg-muted focus-visible:bg-muted data-active:bg-foreground/10 data-active:hover:bg-foreground/10 has-focus-visible:bg-muted data-[state=open]:bg-muted relative flex h-8 items-center rounded-md transition-colors focus-visible:outline-none"
          data-thread-id={thread.id}
          data-pending={isPending || undefined}
        >
          <ThreadListItemPrimitive.Trigger
            data-slot="aui_thread-list-item-trigger"
            className="thread-main focus-visible:ring-ring/50 flex h-full min-w-0 flex-1 items-center rounded-md ps-8 pe-2 text-start text-sm outline-none focus-visible:ring-[3px]"
            disabled={props.isSwitching}
            onClickCapture={preventPrimitiveThreadAction}
            onClick={(event) =>
              runControlledThreadAction(event, () => {
                if (!props.active) props.onOpen(thread);
              })
            }
          >
            <span data-slot="aui_thread-list-item-title" className="min-w-0 flex-1 truncate">
              <ThreadListItemPrimitive.Title fallback="新会话" />
            </span>
            {thread.running ? <span className="running-dot" aria-label="运行中" /> : null}
          </ThreadListItemPrimitive.Trigger>
        </ThreadListItemPrimitive.Root>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          data-slot="aui_thread-list-item-context-menu"
          className="bg-popover/95 text-popover-foreground data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:animate-out z-(--stack-menu) min-w-32 overflow-hidden rounded-md border p-1 shadow-(--elevation-popover) backdrop-blur-sm"
        >
          <ContextMenu.Item
            data-slot="aui_thread-list-item-context-menu-item"
            className="hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground flex cursor-pointer items-center gap-2 rounded-sm px-2.5 py-1.5 text-sm outline-none select-none"
            onSelect={() => props.onRenameStart(thread)}
          >
            <Pencil size={14} /> 重命名
          </ContextMenu.Item>
          <ThreadListItemPrimitive.Archive asChild disabled={props.isArchivePending}>
            <ContextMenu.Item
              data-slot="aui_thread-list-item-context-menu-item"
              className="hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground flex cursor-pointer items-center gap-2 rounded-sm px-2.5 py-1.5 text-sm outline-none select-none"
              onClickCapture={preventPrimitiveThreadAction}
              onClick={(event) => runControlledThreadAction(event, () => props.onArchive(thread, true))}
            >
              <Archive size={14} /> 归档
            </ContextMenu.Item>
          </ThreadListItemPrimitive.Archive>
          <ThreadListItemPrimitive.Delete asChild disabled={props.isDeletePending}>
            <ContextMenu.Item
              data-slot="aui_thread-list-item-context-menu-item"
              className="text-destructive hover:bg-destructive/10 hover:text-destructive focus:bg-destructive/10 focus:text-destructive flex cursor-pointer items-center gap-2 rounded-sm px-2.5 py-1.5 text-sm outline-none select-none"
              onClickCapture={preventPrimitiveThreadAction}
              onClick={(event) => runControlledThreadAction(event, () => props.onDelete(thread))}
            >
              <Trash2 size={14} /> 删除
            </ContextMenu.Item>
          </ThreadListItemPrimitive.Delete>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
});
