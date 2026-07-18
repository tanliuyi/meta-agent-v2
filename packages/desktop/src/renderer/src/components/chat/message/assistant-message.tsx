import { ActionBarPrimitive, AuiIf, ErrorPrimitive, MessagePrimitive, useAuiState } from "@assistant-ui/react";
import { Check, Copy, RotateCcw } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { ReasoningContent, ReasoningRoot, ReasoningText, ReasoningTrigger } from "../../assistant-ui/reasoning.tsx";
import { StreamdownText } from "../../assistant-ui/streamdown-text.tsx";
import { TooltipIconButton } from "../../assistant-ui/tooltip-icon-button.tsx";
import { createRunGroupPart, hasTextAfterGroup, summarizeChainOfThought } from "../message-part-grouping.ts";
import { PiNoticeView } from "../pi-notice-view.tsx";
import { ToolView } from "../tool-view.tsx";

export function AssistantMessage({ isRunActivityRunning }: { isRunActivityRunning: boolean }) {
  const messageParts = useAuiState((state) => state.message.parts);
  const isMessageRunning = useAuiState((state) => state.message.status?.type === "running");
  const groupMessagePart = useMemo(() => createRunGroupPart(messageParts), [messageParts]);

  const isPersistedPiAssistant = useAuiState((state) => {
    const pi = state.message.metadata.custom.pi;
    return (
      pi !== null &&
      typeof pi === "object" &&
      "kind" in pi &&
      pi.kind === "assistant" &&
      "sourceEntryId" in pi &&
      typeof pi.sourceEntryId === "string" &&
      !state.message.metadata.isOptimistic
    );
  });

  const hasCopyableText = useMemo(() => {
    const lastPart = messageParts.at(-1);
    return lastPart?.type === "text" && lastPart.text.trim().length > 0;
  }, [messageParts]);

  return (
    <MessagePrimitive.Root
      data-slot="aui-assistant-message-root"
      data-role="assistant"
      className="fade-in slide-in-from-bottom-1 animate-in relative -mb-7 pb-7 duration-150 [contain-intrinsic-size:auto_200px] [content-visibility:auto]"
    >
      <div className="flex flex-col gap-3 text-sm leading-relaxed text-foreground wrap-break-word">
        <MessagePrimitive.GroupedParts groupBy={groupMessagePart} indicator="never">
          {({ part, children }) => {
            switch (part.type) {
              case "group-runActivity":
                return <RunActivityGroup running={isRunActivityRunning}>{children}</RunActivityGroup>;
              case "group-chainOfThought": {
                const isLatestGroup = part.indices.at(-1) === messageParts.length - 1;
                const running = part.status.type === "running" || (isMessageRunning && isLatestGroup);
                return (
                  <ChainOfThoughtGroup
                    indices={part.indices}
                    running={running}
                    hasFollowingText={hasTextAfterGroup(messageParts, part.indices)}
                  >
                    {children}
                  </ChainOfThoughtGroup>
                );
              }
              case "text":
              case "reasoning":
                return <StreamdownText />;
              case "tool-call":
                return part.toolUI ?? <ToolView {...part} />;
              case "data":
                return part.name === "pi-notice" ? <PiNoticeView data={part.data} /> : part.dataRendererUI;
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
      {isPersistedPiAssistant && hasCopyableText ? (
        <div className="flex min-h-7 items-center pt-1">
          <ActionBarPrimitive.Root
            hideWhenRunning
            autohide="not-last"
            className="animate-in fade-in flex gap-1 text-muted-foreground duration-200"
          >
            {hasCopyableText ? (
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
            ) : null}
            {/* 产品约束：非最终回复不展示入口；assistant-ui reload 链路保持注册。 */}
            <AuiIf condition={(state) => state.message.isLast && state.message.status?.type === "complete"}>
              <ActionBarPrimitive.Reload asChild>
                <TooltipIconButton tooltip="重新生成" side="top">
                  <RotateCcw />
                </TooltipIconButton>
              </ActionBarPrimitive.Reload>
            </AuiIf>
          </ActionBarPrimitive.Root>
        </div>
      ) : null}
    </MessagePrimitive.Root>
  );
}

export function RunActivityGroup({ running, children }: { running: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const previousRunning = useRef(running);

  useEffect(() => {
    if (previousRunning.current && !running) setOpen(false);
    previousRunning.current = running;
  }, [running]);

  return (
    <ReasoningRoot
      variant="ghost"
      className="aui-run-activity-root"
      open={running || open}
      onOpenChange={(nextOpen) => {
        if (!running) setOpen(nextOpen);
      }}
    >
      <ReasoningTrigger
        className="aui-run-activity-trigger"
        label={running ? "正在处理" : "已处理"}
        active={running}
        disabled={running}
      />
      <ReasoningContent className="aui-run-activity-content text-foreground" fade={false} aria-busy={running}>
        <div className="aui-run-activity-body flex flex-col gap-3 py-2">{children}</div>
      </ReasoningContent>
    </ReasoningRoot>
  );
}

function ChainOfThoughtGroup({
  indices,
  running,
  hasFollowingText,
  children,
}: {
  indices: readonly number[];
  running: boolean;
  hasFollowingText: boolean;
  children: ReactNode;
}) {
  const label = useAuiState((state) => summarizeChainOfThought(state.message.parts, indices));
  const [wasRunning, setWasRunning] = useState(running);

  useEffect(() => {
    if (running) setWasRunning(true);
  }, [running]);

  return (
    <ReasoningRoot variant="ghost" autoOpen={wasRunning && !hasFollowingText} streaming={running}>
      <ReasoningTrigger label={label} active={running} />
      <ReasoningContent className="text-foreground" aria-busy={running}>
        <ReasoningText>{children}</ReasoningText>
      </ReasoningContent>
    </ReasoningRoot>
  );
}
