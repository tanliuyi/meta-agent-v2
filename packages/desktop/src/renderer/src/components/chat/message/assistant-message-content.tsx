import { ErrorPrimitive, MessagePrimitive, useAuiState } from "@assistant-ui/react";
import AlertCircle from "lucide-react/dist/esm/icons/circle-alert.mjs";
import { useMemo } from "react";
import { useThinkingVisibility } from "../../../state/thinking-visibility.tsx";
import { StreamdownText } from "../../assistant-ui/streamdown/streamdown-text.tsx";
import { createRunGroupPart, hasFinalResponseInRun, hasTextAfterGroup } from "../message-part-grouping.ts";
import { PiNoticeView } from "../pi-notice-view.tsx";
import { ToolView } from "../tool-view.tsx";
import { ChainOfThoughtGroup } from "./chain-of-thought-group.tsx";
import { RunActivityGroup } from "./run-activity-group.tsx";

export function AssistantMessageContent({
  isRunActivityRunning,
  isMessageRunning,
}: {
  isRunActivityRunning: boolean;
  isMessageRunning: boolean;
}) {
  const { showThinking, autoExpandRunning, showAvatars } = useThinkingVisibility();
  const messageParts = useAuiState((state) => state.message.parts);
  const messageId = useAuiState((state) => state.message.id);
  const toolUIs = useAuiState((state) => state.tools.toolUIs);
  const runStartedAt = useAuiState((state) => state.message.createdAt.getTime());
  const runCompletedAt = useAuiState((state) => piCompletedAt(state.message.metadata.custom));
  const runHasFinalResponse = useAuiState((state) => hasFinalResponseInRun(state.thread.messages, state.message.id));
  const groupMessagePart = useMemo(() => createRunGroupPart(messageParts), [messageParts]);
  const defaultOpenCompletedActivity = showAvatars && !runHasFinalResponse;
  const hasGroupedRunActivity = useMemo(
    () => messageParts.some((part) => groupMessagePart(part, { toolUIs })[0] === "group-runActivity"),
    [groupMessagePart, messageParts, toolUIs],
  );

  return (
    <div
      data-aui-quote-selectable=""
      className={
        showAvatars
          ? "flex flex-col gap-2 text-sm/6 text-foreground wrap-break-word"
          : "flex flex-col gap-3 text-sm/6 text-foreground wrap-break-word"
      }
    >
      {isRunActivityRunning && !hasGroupedRunActivity ? (
        <RunActivityGroup
          running
          startedAt={runStartedAt}
          completedAt={runCompletedAt}
          hasContent={false}
          defaultOpenWhenComplete={defaultOpenCompletedActivity}
          stateKey={`${messageId}:run-activity`}
        >
          {null}
        </RunActivityGroup>
      ) : null}
      <MessagePrimitive.GroupedParts groupBy={groupMessagePart} indicator="never">
        {({ part, children }) => {
          switch (part.type) {
            case "group-runActivity":
              return (
                <RunActivityGroup
                  running={isRunActivityRunning}
                  startedAt={runStartedAt}
                  completedAt={runCompletedAt}
                  hasContent={showThinking || part.indices.some((index) => messageParts[index]?.type !== "reasoning")}
                  defaultOpenWhenComplete={defaultOpenCompletedActivity}
                  stateKey={`${messageId}:run-activity`}
                >
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
                  autoExpandRunning={autoExpandRunning}
                  stateKey={`${messageId}:chain-of-thought:${part.indices[0]}`}
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
        <ErrorPrimitive.Root className="mt-1 flex flex-row items-start gap-1.5 py-1 text-md leading-relaxed text-muted-foreground">
          <AlertCircle className="mt-[5px] size-3.5 shrink-0 text-destructive/70" aria-hidden="true" />
          <ErrorPrimitive.Message className="line-clamp-2 min-w-0" />
        </ErrorPrimitive.Root>
      </MessagePrimitive.Error>
    </div>
  );
}

function piCompletedAt(custom: unknown): number | undefined {
  if (!custom || typeof custom !== "object" || !("pi" in custom)) return undefined;
  const pi = custom.pi;
  if (!pi || typeof pi !== "object" || !("completedAt" in pi)) return undefined;
  return typeof pi.completedAt === "number" && Number.isFinite(pi.completedAt) ? pi.completedAt : undefined;
}
