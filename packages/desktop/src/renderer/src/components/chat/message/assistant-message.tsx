import { ActionBarPrimitive, AuiIf, ErrorPrimitive, MessagePrimitive, useAuiState } from "@assistant-ui/react";
import { Check, Copy } from "lucide-react";
import { type ReactNode, useMemo } from "react";
import { ReasoningContent, ReasoningRoot, ReasoningText, ReasoningTrigger } from "../../assistant-ui/reasoning.tsx";
import { StreamdownText } from "../../assistant-ui/streamdown-text.tsx";
import { TooltipIconButton } from "../../assistant-ui/tooltip-icon-button.tsx";
import { createProcessGroupBy, hasFinalResponseText, summarizeChainOfThought } from "../message-part-grouping.ts";
import { ToolView } from "../tool-view.tsx";

export function AssistantMessage() {
  const messageParts = useAuiState((state) => state.message.parts);
  const isMessageRunning = useAuiState((state) => state.message.status?.type === "running");
  const hasFinalText = useMemo(() => hasFinalResponseText(messageParts), [messageParts]);
  const groupParts = useMemo(
    () => createProcessGroupBy(messageParts, isMessageRunning),
    [isMessageRunning, messageParts],
  );
  return (
    <MessagePrimitive.Root
      data-slot="aui-assistant-message-root"
      data-role="assistant"
      className="fade-in slide-in-from-bottom-1 animate-in relative -mb-7 pb-7 duration-150 [contain-intrinsic-size:auto_200px] [content-visibility:auto]"
    >
      <div className="flex flex-col gap-2 text-sm leading-relaxed text-foreground wrap-break-word">
        <MessagePrimitive.GroupedParts groupBy={groupParts}>
          {({ part, children }) => {
            switch (part.type) {
              case "group-process":
                return (
                  <ProcessGroup running={isMessageRunning} hasFinalText={hasFinalText}>
                    {children}
                  </ProcessGroup>
                );
              case "group-chainOfThought": {
                const isLatestGroup = part.indices.at(-1) === messageParts.length - 1;
                const running = part.status.type === "running" || (isMessageRunning && isLatestGroup);
                return (
                  <ChainOfThoughtGroup indices={part.indices} running={running}>
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
    </MessagePrimitive.Root>
  );
}

function ChainOfThoughtGroup({
  indices,
  running,
  children,
}: {
  indices: readonly number[];
  running: boolean;
  children: ReactNode;
}) {
  const label = useAuiState((state) => summarizeChainOfThought(state.message.parts, indices));
  return (
    <ReasoningRoot variant="ghost">
      <ReasoningTrigger label={label} active={running} />
      <ReasoningContent className="text-foreground" aria-busy={running}>
        <ReasoningText>{children}</ReasoningText>
      </ReasoningContent>
    </ReasoningRoot>
  );
}

function ProcessGroup({
  running,
  hasFinalText,
  children,
}: {
  running: boolean;
  hasFinalText: boolean;
  children: ReactNode;
}) {
  const label = running ? "正在处理" : "已处理";
  return (
    <ReasoningRoot variant="ghost" autoOpen={running || !hasFinalText} streaming={running}>
      <ReasoningTrigger
        label={label}
        active={running}
        disabled={running}
        className="w-full max-w-none border-b border-border/60 pb-2.5"
      />
      <ReasoningContent className="text-foreground" aria-busy={running}>
        <ReasoningText className="mt-3 max-h-[none] overflow-visible p-0 text-foreground">{children}</ReasoningText>
      </ReasoningContent>
    </ReasoningRoot>
  );
}
