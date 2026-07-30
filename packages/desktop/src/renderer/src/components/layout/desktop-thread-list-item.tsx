import * as ContextMenu from "@radix-ui/react-context-menu";
import Archive from "lucide-react/dist/esm/icons/archive.mjs";
import Bot from "lucide-react/dist/esm/icons/bot.mjs";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.mjs";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right.mjs";
import Eye from "lucide-react/dist/esm/icons/eye.mjs";
import GitBranch from "lucide-react/dist/esm/icons/git-branch.mjs";
import Pencil from "lucide-react/dist/esm/icons/pencil.mjs";
import Square from "lucide-react/dist/esm/icons/square.mjs";
import Trash2 from "lucide-react/dist/esm/icons/trash-2.mjs";
import { memo } from "react";
import type { Thread } from "../../../../shared/contracts.ts";
import { builtinSubagentDisplayName } from "../../shared/lib/builtin-subagent-name.ts";
import { ContextMenuContent } from "../../shared/ui/context-menu-content.tsx";
import { ContextMenuItem } from "../../shared/ui/context-menu-item.tsx";
import { Badge } from "../assistant-ui/badge.tsx";
import { ThreadElapsedTime } from "./thread-elapsed-time.tsx";

const TREE_GUIDE_START = 16;
const TREE_LEVEL_INDENT = 16;
const TREE_TOGGLE_SIZE = 16;

interface DesktopThreadListItemProps {
  thread: Thread;
  active: boolean;
  isSwitching: boolean;
  isRenamingPending: boolean;
  isStopPending: boolean;
  isArchivePending: boolean;
  isDeletePending: boolean;
  depth: number;
  childCount: number;
  runningChildCount: number;
  expanded: boolean;
  ancestorContinuations: readonly boolean[];
  isLastChild: boolean;
  compactRoot?: boolean;
  onToggle(threadId: string): void;
  onRenameStart(thread: Thread): void;
  onStop(thread: Thread): void;
  onOpen(thread: Thread): void;
  onArchive(thread: Thread, archived: boolean): void;
  onDelete(thread: Thread): void;
}

/** 使用语义化 list、link 和 ContextMenu 实现的可访问性等效项。 */
export const DesktopThreadListItem = memo(function DesktopThreadListItem(props: DesktopThreadListItemProps) {
  const { thread } = props;
  const subagentDisplayName = thread.agentName ? builtinSubagentDisplayName(thread.agentName) : undefined;
  const activeSubagent = thread.origin === "subagent" && thread.running;
  const isPending =
    props.isSwitching ||
    props.isRenamingPending ||
    props.isStopPending ||
    props.isArchivePending ||
    props.isDeletePending;
  const contentIndent =
    props.compactRoot && props.depth === 0 && props.childCount === 0 ? 8 : 32 + props.depth * TREE_LEVEL_INDENT;
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div
          className="thread-row group hover:bg-muted focus-visible:bg-muted data-active:bg-foreground/10 data-active:hover:bg-foreground/10 has-focus-visible:bg-muted data-[state=open]:bg-muted relative flex h-8 items-center rounded-xl transition-colors focus-visible:outline-none"
          data-thread-id={thread.id}
          data-active={props.active || undefined}
          data-pending={isPending || undefined}
          data-depth={props.depth}
        >
          {props.depth > 0 ? (
            <span aria-hidden="true" className="pointer-events-none absolute inset-0">
              {props.ancestorContinuations.map((continues, level) =>
                continues ? (
                  <span
                    key={level}
                    className="border-border absolute inset-y-0 border-s"
                    style={{ insetInlineStart: TREE_GUIDE_START + level * TREE_LEVEL_INDENT }}
                  />
                ) : null,
              )}
              <span
                className={
                  props.isLastChild
                    ? "border-border absolute top-0 h-1/2 border-s"
                    : "border-border absolute inset-y-0 border-s"
                }
                style={{ insetInlineStart: TREE_GUIDE_START + (props.depth - 1) * TREE_LEVEL_INDENT }}
              />
              <span
                className="border-border absolute top-1/2 border-t"
                style={{
                  inlineSize: props.childCount > 0 ? TREE_LEVEL_INDENT - TREE_TOGGLE_SIZE / 2 : TREE_LEVEL_INDENT,
                  insetInlineStart: TREE_GUIDE_START + (props.depth - 1) * TREE_LEVEL_INDENT,
                }}
              />
            </span>
          ) : null}
          {props.expanded ? (
            <span
              aria-hidden="true"
              className="border-border pointer-events-none absolute bottom-0 border-s"
              style={{
                insetInlineStart: TREE_GUIDE_START + props.depth * TREE_LEVEL_INDENT,
                top: `calc(50% + ${TREE_TOGGLE_SIZE / 2}px)`,
              }}
            />
          ) : null}
          {props.childCount > 0 ? (
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 bg-background ring-border/60 hover:bg-muted group-data-[active=true]:bg-muted group-data-[state=open]:bg-muted absolute z-6 grid place-items-center rounded-xl outline-none focus-visible:ring-[3px]"
              style={{
                blockSize: TREE_TOGGLE_SIZE,
                inlineSize: TREE_TOGGLE_SIZE,
                insetInlineStart: TREE_GUIDE_START - TREE_TOGGLE_SIZE / 2 + props.depth * TREE_LEVEL_INDENT,
              }}
              aria-label={props.expanded ? "收起子会话" : "展开子会话"}
              aria-expanded={props.expanded}
              onClick={() => props.onToggle(thread.id)}
            >
              {props.expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
          ) : null}
          <button
            type="button"
            className="thread-main focus-visible:ring-ring/50 flex h-full min-w-0 flex-1 items-center gap-1 rounded-xl pe-2 text-start outline-none focus-visible:ring-[3px]"
            style={{ paddingInlineStart: contentIndent }}
            role="treeitem"
            aria-level={props.depth + 1}
            aria-expanded={props.childCount > 0 ? props.expanded : undefined}
            aria-selected={props.active}
            disabled={props.isSwitching}
            onClick={() => {
              if (!props.active) props.onOpen(thread);
            }}
          >
            {thread.origin === "subagent" ? (
              <Bot className="text-muted-foreground size-3.5 shrink-0" aria-label="子智能体会话" />
            ) : thread.origin === "branch" ? (
              <GitBranch className="text-muted-foreground size-3.5 shrink-0" aria-label="分支会话" />
            ) : null}
            {thread.origin === "subagent" && thread.agentName && subagentDisplayName ? (
              <Badge
                data-slot="subagent-name"
                variant="muted"
                size="sm"
                className="max-w-20 shrink-0 truncate"
                title={thread.agentName}
              >
                {subagentDisplayName}
              </Badge>
            ) : null}
            <span data-slot="thread-title" className="min-w-0 flex-1 truncate" title={thread.title || "新会话"}>
              {thread.title || "新会话"}
            </span>
            {!props.expanded && props.runningChildCount > 0 ? (
              <span
                className="text-muted-foreground shrink-0 text-xs"
                aria-label={`${props.runningChildCount} 个子会话正在运行`}
              >
                {props.runningChildCount}
              </span>
            ) : null}
            {thread.running ? (
              <span className="running-dot" aria-label="运行中" />
            ) : (
              <ThreadElapsedTime updatedAt={thread.updatedAt} />
            )}
          </button>
        </div>
      </ContextMenu.Trigger>
      <ContextMenuContent>
        {thread.origin === "subagent" ? (
          <ContextMenuItem disabled={props.isSwitching} onSelect={() => props.onOpen(thread)}>
            <Eye /> 查看运行详情
          </ContextMenuItem>
        ) : null}
        {activeSubagent ? (
          <ContextMenuItem
            variant="destructive"
            disabled={props.isSwitching || props.isStopPending}
            onSelect={() => props.onStop(thread)}
          >
            <Square /> 停止运行
          </ContextMenuItem>
        ) : null}
        <ContextMenuItem disabled={props.isSwitching || activeSubagent} onSelect={() => props.onRenameStart(thread)}>
          <Pencil /> 重命名
        </ContextMenuItem>
        <ContextMenuItem disabled={props.isSwitching || activeSubagent} onSelect={() => props.onArchive(thread, true)}>
          <Archive /> 归档
        </ContextMenuItem>
        <ContextMenuItem
          variant="destructive"
          disabled={props.isSwitching || activeSubagent}
          onSelect={() => props.onDelete(thread)}
        >
          <Trash2 /> 删除
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu.Root>
  );
});
