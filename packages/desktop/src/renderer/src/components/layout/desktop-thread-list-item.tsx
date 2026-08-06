import { autoUpdate, FloatingPortal, flip, offset, shift, useFloating } from "@floating-ui/react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import Archive from "lucide-react/dist/esm/icons/archive.mjs";
import ArrowUpToLine from "lucide-react/dist/esm/icons/arrow-up-to-line.mjs";
import Bot from "lucide-react/dist/esm/icons/bot.mjs";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.mjs";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right.mjs";
import GitBranch from "lucide-react/dist/esm/icons/git-branch.mjs";
import PanelRight from "lucide-react/dist/esm/icons/panel-right.mjs";
import Pencil from "lucide-react/dist/esm/icons/pencil.mjs";
import Pin from "lucide-react/dist/esm/icons/pin.mjs";
import PinOff from "lucide-react/dist/esm/icons/pin-off.mjs";
import Square from "lucide-react/dist/esm/icons/square.mjs";
import Trash2 from "lucide-react/dist/esm/icons/trash-2.mjs";
import { memo, useMemo, useRef, useState } from "react";
import type { LinkSafetyConfig } from "streamdown";
import type { Thread } from "../../../../shared/contracts.ts";
import { builtinSubagentDisplayName } from "../../shared/lib/builtin-subagent-name.ts";
import { ContextMenuContent } from "../../shared/ui/context-menu-content.tsx";
import { ContextMenuItem } from "../../shared/ui/context-menu-item.tsx";
import { THREAD_DRAG_MIME, useThreadDrag } from "../../state/thread-drag-context.tsx";
import { Badge } from "../assistant-ui/badge.tsx";
import { StreamdownMarkdown } from "../assistant-ui/streamdown/streamdown-markdown.tsx";

const TREE_GUIDE_START = 16;
const TREE_LEVEL_INDENT = 16;
const TREE_TOGGLE_SIZE = 16;

// 侧边栏悬浮预览无会话上下文，链接确认 modal 依赖 SessionScope，故禁用链接安全。
const PREVIEW_LINK_SAFETY: LinkSafetyConfig = { enabled: false };

interface DesktopThreadListItemProps {
  thread: Thread;
  active: boolean;
  isSwitching: boolean;
  isRenamingPending: boolean;
  isStopPending: boolean;
  isArchivePending: boolean;
  isDeletePending: boolean;
  isPromotePending: boolean;
  isPinned?: boolean;
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
  onOpenInSidebar(thread: Thread): void;
  /** 主工作区无活动会话或该会话已是活动会话时禁用侧边栏打开。 */
  sidebarOpenDisabled: boolean;
  /** 禁用时的 tooltip 文案（可选，默认“无法在侧边栏打开”）。 */
  sidebarOpenDisabledReason?: string;
  onArchive(thread: Thread, archived: boolean): void;
  onDelete(thread: Thread): void;
  onPromote(thread: Thread): void;
  onTogglePin?(thread: Thread): void;
}

/** 使用语义化 list、link 和 ContextMenu 实现的可访问性等效项。 */
export const DesktopThreadListItem = memo(function DesktopThreadListItem(props: DesktopThreadListItemProps) {
  const { thread } = props;
  const { setDragged } = useThreadDrag();
  const dragImageRef = useRef<HTMLDivElement | null>(null);
  const subagentDisplayName = thread.agentName ? builtinSubagentDisplayName(thread.agentName) : undefined;
  const activeSubagent = thread.origin === "subagent" && thread.running;
  const isPending =
    props.isSwitching ||
    props.isRenamingPending ||
    props.isStopPending ||
    props.isArchivePending ||
    props.isDeletePending ||
    props.isPromotePending;
  const contentIndent =
    props.compactRoot && props.depth === 0 && props.childCount === 0 ? 8 : 32 + props.depth * TREE_LEVEL_INDENT;
  const [previewHovered, setPreviewHovered] = useState(false);
  const userPreview = thread.lastUserPreview?.trim() ?? "";
  const assistantPreview = thread.lastAssistantPreview?.trim() ?? "";
  const previewVisible = userPreview.length > 0 && assistantPreview.length > 0;
  const previewMiddleware = useMemo(() => [offset(14), flip({}), shift({ padding: 12 })], []);
  const { refs, floatingStyles } = useFloating({
    open: previewHovered && previewVisible,
    placement: "right",
    middleware: previewMiddleware,
    whileElementsMounted: autoUpdate,
  });
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div
          className="thread-row group hover:bg-foreground/[0.055] active:bg-foreground/[0.09] focus-visible:bg-foreground/[0.055] data-active:bg-foreground/[0.085] data-active:hover:bg-foreground/[0.085] has-focus-visible:bg-foreground/[0.055] data-[state=open]:bg-foreground/[0.055] relative flex h-8 items-center rounded-xl transition-colors focus-visible:outline-none"
          data-thread-id={thread.id}
          data-active={props.active || undefined}
          data-pending={isPending || undefined}
          data-depth={props.depth}
          draggable
          onDragStart={(event) => {
            event.dataTransfer.effectAllowed = "copy";
            event.dataTransfer.setData(THREAD_DRAG_MIME, thread.id);
            setDragged({
              projectId: thread.projectId,
              threadId: thread.id,
              title: thread.title || "新会话",
              agentName: thread.agentName,
            });
            const image = dragImageRef.current;
            if (image) event.dataTransfer.setDragImage(image, 16, 14);
          }}
          onDragEnd={() => setDragged(null)}
        >
          {props.depth > 0 ? (
            <span aria-hidden="true" className="pointer-events-none absolute inset-0">
              {props.ancestorContinuations.map((continues, level) =>
                continues ? (
                  <span
                    key={level}
                    className="border-foreground/15 absolute inset-y-0 border-s"
                    style={{ insetInlineStart: TREE_GUIDE_START + level * TREE_LEVEL_INDENT }}
                  />
                ) : null,
              )}
              <span
                className={
                  props.isLastChild
                    ? "border-foreground/15 absolute top-0 h-1/2 border-s"
                    : "border-foreground/15 absolute inset-y-0 border-s"
                }
                style={{ insetInlineStart: TREE_GUIDE_START + (props.depth - 1) * TREE_LEVEL_INDENT }}
              />
              <span
                className="border-foreground/15 absolute top-1/2 border-t"
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
              className="border-foreground/15 pointer-events-none absolute bottom-0 border-s"
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
            ref={refs.setReference}
            className="thread-main focus-visible:ring-ring/50 flex h-full min-w-0 flex-1 items-center gap-1 rounded-xl pe-2 text-start outline-none focus-visible:ring-[3px]"
            style={{ paddingInlineStart: contentIndent }}
            role="treeitem"
            aria-level={props.depth + 1}
            aria-expanded={props.childCount > 0 ? props.expanded : undefined}
            aria-selected={props.active}
            disabled={props.isSwitching}
            onPointerEnter={() => setPreviewHovered(true)}
            onPointerLeave={() => setPreviewHovered(false)}
            onClick={() => {
              if (!props.active) props.onOpen(thread);
            }}
          >
            {props.isPinned ? <Pin className="text-muted-foreground size-3 shrink-0" aria-label="已置顶" /> : null}
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
            <span data-slot="thread-title" className="min-w-0 flex-1 truncate">
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
            ) : thread.completed === true && !props.active ? (
              <span className="completed-dot" aria-label="运行已完成" />
            ) : null}
          </button>
          <div ref={dragImageRef} className="thread-drag-image" aria-hidden="true">
            <PanelRight className="size-3.5 shrink-0" />
            <span className="thread-drag-image-title">{thread.title || "新会话"}</span>
            <span className="thread-drag-image-hint">在侧边栏打开</span>
          </div>
          {previewHovered && previewVisible ? (
            <FloatingPortal preserveTabOrder={false}>
              <div ref={refs.setFloating} className="message-navigation-summary" style={floatingStyles} role="tooltip">
                <span>{userPreview}</span>
                <div className="message-navigation-summary-markdown">
                  <StreamdownMarkdown linkSafety={PREVIEW_LINK_SAFETY}>{assistantPreview}</StreamdownMarkdown>
                </div>
              </div>
            </FloatingPortal>
          ) : null}
        </div>
      </ContextMenu.Trigger>
      <ContextMenuContent>
        <ContextMenuItem disabled={props.isSwitching} onSelect={() => props.onTogglePin?.(thread)}>
          {props.isPinned ? <PinOff /> : <Pin />} {props.isPinned ? "取消置顶" : "置顶"}
        </ContextMenuItem>
        <ContextMenuItem
          disabled={props.isSwitching || props.sidebarOpenDisabled}
          title={props.sidebarOpenDisabled ? (props.sidebarOpenDisabledReason ?? "无法在侧边栏打开") : undefined}
          onSelect={() => props.onOpenInSidebar(thread)}
        >
          <PanelRight /> 在侧边栏打开
        </ContextMenuItem>
        <ContextMenuItem disabled={props.isSwitching || activeSubagent} onSelect={() => props.onRenameStart(thread)}>
          <Pencil /> 重命名
        </ContextMenuItem>
        <ContextMenuItem disabled={props.isSwitching || activeSubagent} onSelect={() => props.onArchive(thread, true)}>
          <Archive /> 归档
        </ContextMenuItem>
        {thread.parentThreadId ? (
          <ContextMenuItem
            disabled={props.isSwitching || props.isPromotePending || activeSubagent}
            onSelect={() => props.onPromote(thread)}
          >
            <ArrowUpToLine /> 提升为根会话
          </ContextMenuItem>
        ) : null}
        {activeSubagent ? (
          <>
            <ContextMenu.Separator className="bg-border -mx-1 my-1 h-px" />
            <ContextMenuItem
              variant="destructive"
              disabled={props.isSwitching || props.isStopPending}
              onSelect={() => props.onStop(thread)}
            >
              <Square /> 停止运行
            </ContextMenuItem>
          </>
        ) : null}
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
