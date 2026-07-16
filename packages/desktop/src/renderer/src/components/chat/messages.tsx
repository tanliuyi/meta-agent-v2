import {
  ActionBarPrimitive,
  AuiIf,
  BranchPickerPrimitive,
  ComposerPrimitive,
  ErrorPrimitive,
  MessagePrimitive,
  useAuiState,
} from "@assistant-ui/react";
import { Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Copy, Pencil } from "lucide-react";
import { createContext, type ReactNode, useContext, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cn } from "../../lib/cn.ts";
import { UserMessageAttachments } from "../assistant-ui/attachment.tsx";
import { ReasoningContent, ReasoningRoot, ReasoningText, ReasoningTrigger } from "../assistant-ui/reasoning.tsx";
import { StreamdownText } from "../assistant-ui/streamdown-text.tsx";
import { TooltipIconButton } from "../assistant-ui/tooltip-icon-button.tsx";
import { Button } from "../ui/button.tsx";
import { createProcessGroupBy } from "./message-part-grouping.ts";
import { ToolView } from "./tool-view.tsx";

interface MessageEntranceAnimationState {
  isRunning: boolean;
  seenMessageIds: Set<string>;
}

const MessageEntranceAnimationContext = createContext<MessageEntranceAnimationState | null>(null);
const MessageProcessContext = createContext(false);
const COLLAPSED_USER_MESSAGE_HEIGHT = 160;

export function MessageEntranceAnimationProvider({
  children,
  isRunning,
  messageIds,
}: {
  children: ReactNode;
  isRunning: boolean;
  messageIds: readonly string[];
}) {
  const [seenMessageIds] = useState(() => new Set(messageIds));
  useLayoutEffect(() => {
    if (!isRunning) {
      for (const messageId of messageIds) seenMessageIds.add(messageId);
    }
  }, [isRunning, messageIds, seenMessageIds]);
  const value = useMemo(() => ({ isRunning, seenMessageIds }), [isRunning, seenMessageIds]);
  return <MessageEntranceAnimationContext.Provider value={value}>{children}</MessageEntranceAnimationContext.Provider>;
}

export function MessageProcessGroup({
  children,
  durationMs,
  isRunning,
}: {
  children: ReactNode;
  durationMs?: number;
  isRunning: boolean;
}) {
  return (
    <MessageProcessContext.Provider value>
      <div data-slot="aui-turn-process">
        <ReasoningRoot variant="ghost" open={isRunning ? true : undefined} streaming={isRunning}>
          <ReasoningTrigger label={processLabel(isRunning, durationMs)} active={isRunning} disabled={isRunning} />
          <ReasoningContent aria-busy={isRunning}>
            <ReasoningText className="max-h-[none] overflow-visible p-0">{children}</ReasoningText>
          </ReasoningContent>
        </ReasoningRoot>
      </div>
    </MessageProcessContext.Provider>
  );
}

export const THREAD_MESSAGE_COMPONENTS = { UserMessage, AssistantMessage };

function UserMessage() {
  const animateEntrance = useMessageEntranceAnimation();
  const isEditing = useAuiState((state) => state.message.composer.isEditing);
  if (isEditing) return <EditComposer />;

  return (
    <MessagePrimitive.Root
      data-slot="aui_user-message-root"
      data-role="user"
      className={cn(
        "grid auto-rows-auto grid-cols-[minmax(72px,1fr)_auto] content-start gap-y-2 px-2 duration-150 [contain-intrinsic-size:auto_200px] [content-visibility:auto] [&:where(>*)]:col-start-2",
        animateEntrance && "fade-in slide-in-from-bottom-1 animate-in duration-150",
      )}
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
    <div className="aui-user-message-content bg-muted text-foreground rounded-xl px-4 py-2 wrap-break-word">
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
      className="aui-user-action-bar-root flex items-center gap-1"
    >
      <ActionBarPrimitive.Edit asChild>
        <TooltipIconButton tooltip="编辑消息" className="aui-user-action-edit">
          <Pencil />
        </TooltipIconButton>
      </ActionBarPrimitive.Edit>
    </ActionBarPrimitive.Root>
  );
}

function BranchPicker({ className, ...props }: React.ComponentProps<typeof BranchPickerPrimitive.Root>) {
  return (
    <BranchPickerPrimitive.Root
      hideWhenSingleBranch
      className={cn(
        "aui-branch-picker-root text-muted-foreground -ms-2 me-2 inline-flex items-center text-xs",
        className,
      )}
      {...props}
    >
      <BranchPickerPrimitive.Previous asChild>
        <TooltipIconButton tooltip="上一个分支">
          <ChevronLeft />
        </TooltipIconButton>
      </BranchPickerPrimitive.Previous>
      <span className="aui-branch-picker-state font-medium">
        <BranchPickerPrimitive.Number /> / <BranchPickerPrimitive.Count />
      </span>
      <BranchPickerPrimitive.Next asChild>
        <TooltipIconButton tooltip="下一个分支">
          <ChevronRight />
        </TooltipIconButton>
      </BranchPickerPrimitive.Next>
    </BranchPickerPrimitive.Root>
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

function AssistantMessage() {
  const animateEntrance = useMessageEntranceAnimation();
  const isInProcessGroup = useContext(MessageProcessContext);
  const durationMs = useAuiState((state) => state.message.metadata.timing?.totalStreamTime);
  const messageParts = useAuiState((state) => state.message.parts);
  const isMessageRunning = useAuiState((state) => state.message.status?.type === "running");
  const groupParts = useMemo(
    () => createProcessGroupBy(messageParts, isMessageRunning),
    [isMessageRunning, messageParts],
  );
  return (
    <MessagePrimitive.Root
      data-slot="aui-assistant-message-root"
      data-role="assistant"
      className={cn(
        "relative",
        !isInProcessGroup && "-mb-7 pb-7",
        animateEntrance && "fade-in slide-in-from-bottom-1 animate-in duration-150",
      )}
    >
      <div className="text-sm leading-relaxed text-foreground wrap-break-word">
        <MessagePrimitive.GroupedParts groupBy={groupParts}>
          {({ part, children }) => {
            switch (part.type) {
              case "group-process": {
                if (isInProcessGroup) return children;
                return (
                  <div data-slot="aui-chain-of-thought">
                    <ReasoningRoot
                      variant="ghost"
                      open={isMessageRunning ? true : undefined}
                      streaming={isMessageRunning}
                    >
                      <ReasoningTrigger
                        label={processLabel(isMessageRunning, durationMs)}
                        active={isMessageRunning}
                        disabled={isMessageRunning}
                      />
                      <ReasoningContent aria-busy={isMessageRunning}>
                        <ReasoningText className="max-h-[none] overflow-visible p-0">{children}</ReasoningText>
                      </ReasoningContent>
                    </ReasoningRoot>
                  </div>
                );
              }
              case "group-tool":
              case "group-reasoning":
              case "group-intermediate-text":
                return children;
              case "text":
              case "reasoning":
                return <StreamdownText />;
              case "tool-call":
                return part.toolUI ?? <ToolView {...part} />;
              case "data":
                return part.dataRendererUI;
              case "indicator":
                return (
                  <span className="animate-pulse text-muted-foreground" aria-label="Assistant 正在工作">
                    ●
                  </span>
                );
              default:
                return null;
            }
          }}
        </MessagePrimitive.GroupedParts>
        <MessagePrimitive.Error>
          <ErrorPrimitive.Root className="mt-2 rounded-md border border-destructive bg-destructive/10 p-3 text-sm text-destructive">
            <ErrorPrimitive.Message className="line-clamp-2" />
          </ErrorPrimitive.Root>
        </MessagePrimitive.Error>
      </div>
      {!isInProcessGroup ? (
        <AuiIf
          condition={(state) => {
            const lastPart = state.message.parts.at(-1);
            return lastPart?.type === "text" && lastPart.text.trim().length > 0;
          }}
        >
          <div className="flex min-h-7 items-center pt-1">
            <ActionBarPrimitive.Root
              hideWhenRunning
              autohide="not-last"
              className="animate-in fade-in flex gap-1 text-muted-foreground duration-200"
            >
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
          </div>
        </AuiIf>
      ) : null}
    </MessagePrimitive.Root>
  );
}

function processLabel(isRunning: boolean, durationMs?: number): string {
  if (isRunning) return "处理中";
  if (durationMs === undefined) return "已处理";
  const seconds = Math.max(1, Math.round(durationMs / 1_000));
  return `已处理 ${seconds}秒`;
}

function useMessageEntranceAnimation(): boolean {
  const messageId = useAuiState((state) => state.message.id);
  const state = useContext(MessageEntranceAnimationContext);
  const animate = state?.isRunning === true && !state.seenMessageIds.has(messageId);
  useLayoutEffect(() => {
    state?.seenMessageIds.add(messageId);
  }, [messageId, state]);
  return animate;
}
