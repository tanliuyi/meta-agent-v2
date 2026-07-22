import { ErrorPrimitive, MessagePrimitive, useAuiState } from "@assistant-ui/react";
import { useMemo } from "react";
import { useThinkingVisibility } from "../../../state/thinking-visibility.tsx";
import { StreamdownText } from "../../assistant-ui/streamdown/streamdown-text.tsx";
import { createRunGroupPart, hasTextAfterGroup } from "../message-part-grouping.ts";
import { PiNoticeView } from "../pi-notice-view.tsx";
import { ToolView } from "../tool-view.tsx";
import { ChainOfThoughtGroup } from "./chain-of-thought-group.tsx";
import { RunActivityGroup } from "./run-activity-group.tsx";

export function AssistantMessageContent({ isRunActivityRunning }: { isRunActivityRunning: boolean }) {
  const { showThinking } = useThinkingVisibility();
  const messageParts = useAuiState((state) => state.message.parts);
  const runStartedAt = useAuiState((state) => state.message.createdAt.getTime());
  const isMessageRunning = useAuiState((state) => state.message.status?.type === "running");
  const groupMessagePart = useMemo(() => createRunGroupPart(messageParts), [messageParts]);

  return (
    <div className="flex flex-col gap-3 text-sm leading-relaxed text-foreground wrap-break-word">
      <MessagePrimitive.GroupedParts groupBy={groupMessagePart} indicator="never">
        {({ part, children }) => {
          switch (part.type) {
            case "group-runActivity":
              return (
                <RunActivityGroup running={isRunActivityRunning} startedAt={runStartedAt}>
                  {children}
                </RunActivityGroup>
              );
            case "group-chainOfThought": {
              const hasToolCall = part.indices.some((index) => messageParts[index]?.type === "tool-call");
              if (!showThinking && !hasToolCall) return null;
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
              return <StreamdownText />;
            case "reasoning":
              return showThinking ? <StreamdownText /> : null;
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
  );
}
