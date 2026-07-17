import { ActionBarPrimitive, AuiIf, ComposerPrimitive, MessagePrimitive, useAuiState } from "@assistant-ui/react";
import { Check, ChevronDown, ChevronUp, Copy, SquarePen } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { cn } from "../../../lib/cn.ts";
import { UserMessageAttachments } from "../../assistant-ui/attachment.tsx";
import { TooltipIconButton } from "../../assistant-ui/tooltip-icon-button.tsx";
import { Button } from "../../ui/button.tsx";
import { BranchPicker } from "./branch-picker.tsx";

const COLLAPSED_USER_MESSAGE_HEIGHT = 160;

export function UserMessage() {
  const isEditing = useAuiState((state) => state.message.composer.isEditing);
  if (isEditing) return <EditComposer />;

  return (
    <MessagePrimitive.Root
      data-slot="aui_user-message-root"
      data-role="user"
      className="fade-in slide-in-from-bottom-1 animate-in grid auto-rows-auto grid-cols-[minmax(72px,1fr)_auto] content-start gap-y-2 px-2 duration-150 [contain-intrinsic-size:auto_200px] [content-visibility:auto] [&:where(>*)]:col-start-2"
    >
      <UserMessageAttachments />

      <div className="aui-user-message-content-wrapper relative col-start-2 min-w-0">
        <UserMessageContent />
      </div>

      <div className="aui-user-message-footer col-span-full col-start-1 row-start-3 flex min-h-7 items-center justify-end">
        <BranchPicker data-slot="aui_user-branch-picker" className="-me-1 justify-end" />
        <UserActionBar />
      </div>
    </MessagePrimitive.Root>
  );
}

function UserMessageContent() {
  const contentRef = useRef<HTMLDivElement>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [isLong, setIsLong] = useState(false);
  const hasContent = useAuiState((state) =>
    state.message.parts.some((part) => part.type !== "text" || part.text.trim().length > 0),
  );

  useLayoutEffect(() => {
    const element = contentRef.current;
    if (!element) return;
    const measure = () => setIsLong(element.scrollHeight > COLLAPSED_USER_MESSAGE_HEIGHT);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  if (!hasContent) return null;

  return (
    <div className="aui-user-message-content bg-muted text-foreground rounded-xl px-4 py-2 wrap-break-word text-sm">
      <div ref={contentRef} className={cn(!isExpanded && "max-h-40 overflow-hidden")}>
        <MessagePrimitive.Parts />
      </div>
      {isLong ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ms-auto mt-1 flex h-6 gap-1 rounded-md px-2 text-xs"
          aria-expanded={isExpanded}
          onClick={() => setIsExpanded((expanded) => !expanded)}
        >
          {isExpanded ? <ChevronUp /> : <ChevronDown />}
          {isExpanded ? "收起" : "展开"}
        </Button>
      ) : null}
    </div>
  );
}

function UserActionBar() {
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="never"
      className="aui-user-action-bar-root animate-in fade-in flex items-center gap-1 text-muted-foreground duration-200"
    >
      <ActionBarPrimitive.Edit asChild>
        <TooltipIconButton tooltip="编辑消息" className="aui-user-action-edit" side="top">
          <SquarePen />
        </TooltipIconButton>
      </ActionBarPrimitive.Edit>

      <ActionBarPrimitive.Copy asChild>
        <TooltipIconButton tooltip="复制消息" side="top">
          <AuiIf condition={(state) => state.message.isCopied}>
            <Check className="animate-in zoom-in-50 fade-in" />
          </AuiIf>
          <AuiIf condition={(state) => !state.message.isCopied}>
            <Copy className="animate-in zoom-in-75 fade-in" />
          </AuiIf>
        </TooltipIconButton>
      </ActionBarPrimitive.Copy>
    </ActionBarPrimitive.Root>
  );
}

function EditComposer() {
  return (
    <MessagePrimitive.Root
      data-slot="aui_edit-composer-wrapper"
      className="flex flex-col px-2 [contain-intrinsic-size:auto_200px] [content-visibility:auto]"
    >
      <ComposerPrimitive.Root className="aui-edit-composer-root border-border/60 dark:border-muted-foreground/15 ms-auto flex w-full max-w-[85%] flex-col rounded-(--composer-radius) border bg-(--composer-bg) shadow-[0_4px_16px_-8px_rgba(0,0,0,0.08),0_1px_2px_rgba(0,0,0,0.04)] dark:shadow-none">
        <ComposerPrimitive.Input
          className="aui-edit-composer-input text-foreground min-h-14 w-full resize-none bg-transparent px-4 pt-3 pb-1 text-base outline-none"
          autoFocus
        />
        <div className="aui-edit-composer-footer mx-2.5 mb-2.5 flex items-center gap-1.5 self-end">
          <ComposerPrimitive.Cancel asChild>
            <Button variant="ghost" size="sm" className="h-8 rounded-full px-3.5">
              取消
            </Button>
          </ComposerPrimitive.Cancel>
          <ComposerPrimitive.Send asChild>
            <Button size="sm" className="h-8 rounded-full px-3.5">
              更新
            </Button>
          </ComposerPrimitive.Send>
        </div>
      </ComposerPrimitive.Root>
    </MessagePrimitive.Root>
  );
}
