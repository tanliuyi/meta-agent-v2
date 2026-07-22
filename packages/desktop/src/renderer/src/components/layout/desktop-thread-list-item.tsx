import * as ContextMenu from "@radix-ui/react-context-menu";
import Archive from "lucide-react/dist/esm/icons/archive.mjs";
import Pencil from "lucide-react/dist/esm/icons/pencil.mjs";
import Trash2 from "lucide-react/dist/esm/icons/trash-2.mjs";
import { memo, useEffect, useState } from "react";
import type { Thread } from "../../../../shared/contracts.ts";

function formatElapsedTime(updatedAt: number, now: number): string {
  const diffMs = now - updatedAt;
  const diffMinutes = Math.floor(diffMs / 60_000);
  if (diffMinutes < 1) return "刚刚";
  if (diffMinutes < 60) return `${diffMinutes} 分钟`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours} 小时`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return `${diffDays} 天`;
  const diffMonths = Math.floor(diffDays / 30);
  if (diffMonths < 12) return `${diffMonths} 个月`;
  return `${Math.floor(diffMonths / 12)} 年`;
}

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
  onPrewarm(thread: Thread): void;
}

/** 使用语义化 list、link 和 ContextMenu 实现的可访问性等效项。 */
export const DesktopThreadListItem = memo(function DesktopThreadListItem(props: DesktopThreadListItemProps) {
  const { thread } = props;
  const isPending = props.isSwitching || props.isRenamingPending || props.isArchivePending || props.isDeletePending;
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(interval);
  }, []);

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div
          className="thread-row group hover:bg-muted focus-visible:bg-muted data-active:bg-foreground/10 data-active:hover:bg-foreground/10 has-focus-visible:bg-muted data-[state=open]:bg-muted relative flex h-8 items-center rounded-md transition-colors focus-visible:outline-none"
          data-thread-id={thread.id}
          data-active={props.active || undefined}
          data-pending={isPending || undefined}
          onMouseEnter={() => {
            if (!props.active && !props.isSwitching) props.onPrewarm(thread);
          }}
          onFocus={() => {
            if (!props.active && !props.isSwitching) props.onPrewarm(thread);
          }}
        >
          <button
            type="button"
            className="thread-main focus-visible:ring-ring/50 flex gap-1 h-full min-w-0 flex-1 items-center rounded-md ps-8 pe-2 text-start text-sm outline-none focus-visible:ring-[3px]"
            disabled={props.isSwitching}
            onClick={() => {
              if (!props.active) props.onOpen(thread);
            }}
          >
            <span className="min-w-0 flex-1 truncate">{thread.title || "新会话"}</span>
            {thread.running ? (
              <span className="running-dot" aria-label="运行中" />
            ) : (
              <span className="thread-time" aria-label="更新时间">
                {formatElapsedTime(thread.updatedAt, now)}
              </span>
            )}
          </button>
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="bg-popover/95 text-popover-foreground data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:animate-out z-(--stack-menu) min-w-32 overflow-hidden rounded-md border p-1 shadow-(--elevation-popover) backdrop-blur-sm">
          <ContextMenu.Item
            className="hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground flex cursor-pointer items-center gap-2 rounded-sm px-2.5 py-1.5 text-sm outline-none select-none"
            disabled={props.isSwitching}
            onSelect={() => props.onRenameStart(thread)}
          >
            <Pencil size={14} /> 重命名
          </ContextMenu.Item>
          <ContextMenu.Item
            className="hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground flex cursor-pointer items-center gap-2 rounded-sm px-2.5 py-1.5 text-sm outline-none select-none"
            disabled={props.isSwitching}
            onSelect={() => props.onArchive(thread, true)}
          >
            <Archive size={14} /> 归档
          </ContextMenu.Item>
          <ContextMenu.Item
            className="text-destructive hover:bg-destructive/10 hover:text-destructive focus:bg-destructive/10 focus:text-destructive flex cursor-pointer items-center gap-2 rounded-sm px-2.5 py-1.5 text-sm outline-none select-none"
            disabled={props.isSwitching}
            onSelect={() => props.onDelete(thread)}
          >
            <Trash2 size={14} /> 删除
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
});
