import { TooltipIconButton } from "@renderer/components/assistant-ui/tooltip-icon-button";
import ArchiveRestore from "lucide-react/dist/esm/icons/archive-restore.mjs";
import GitBranch from "lucide-react/dist/esm/icons/git-branch.mjs";
import Trash2 from "lucide-react/dist/esm/icons/trash-2.mjs";
import { memo } from "react";
import type { Thread } from "../../../../../shared/contracts.ts";

interface ArchivedSessionRowProps {
  thread: Thread;
  pending: boolean;
  /** 点击标题：恢复并打开会话。 */
  onOpen(thread: Thread): void;
  /** 仅恢复（取消归档），留在当前页。 */
  onRestore(thread: Thread): void;
  onDelete(thread: Thread): void;
}

function formatArchivedTime(timestamp: number): string {
  const elapsed = Date.now() - timestamp;
  const minute = 60_000;
  if (elapsed < minute) return "刚刚";
  const hour = 60 * minute;
  if (elapsed < hour) return `${Math.floor(elapsed / minute)} 分钟前`;
  const day = 24 * hour;
  if (elapsed < day) return `${Math.floor(elapsed / hour)} 小时前`;
  if (elapsed < 30 * day) return `${Math.floor(elapsed / day)} 天前`;
  return new Date(timestamp).toLocaleDateString("zh-CN");
}

/** 归档页中的单个会话行：标题（恢复并打开）、更新时间与操作按钮。 */
export const ArchivedSessionRow = memo(function ArchivedSessionRow({
  thread,
  pending,
  onOpen,
  onRestore,
  onDelete,
}: ArchivedSessionRowProps) {
  return (
    <li className="flex min-h-11 items-center gap-3 border-t border-border/80 px-4">
      <button
        type="button"
        className="focus-visible:ring-ring/50 flex min-w-0 flex-1 items-center gap-2 rounded-lg py-1.5 text-start text-sm outline-none focus-visible:ring-[3px] disabled:opacity-50"
        disabled={pending}
        title="恢复并打开"
        onClick={() => onOpen(thread)}
      >
        {thread.origin === "branch" ? (
          <GitBranch className="text-muted-foreground size-3.5 shrink-0" aria-label="分支会话" />
        ) : null}
        <span className="min-w-0 flex-1 truncate">{thread.title || "新会话"}</span>
        {thread.running ? <span className="running-dot shrink-0" aria-label="运行中" /> : null}
      </button>
      <span className="shrink-0 text-xs text-muted-foreground">{formatArchivedTime(thread.updatedAt)}</span>
      <TooltipIconButton tooltip="恢复" disabled={pending} onClick={() => onRestore(thread)}>
        <ArchiveRestore />
      </TooltipIconButton>
      <TooltipIconButton tooltip="删除" disabled={pending} onClick={() => onDelete(thread)}>
        <Trash2 />
      </TooltipIconButton>
    </li>
  );
});
