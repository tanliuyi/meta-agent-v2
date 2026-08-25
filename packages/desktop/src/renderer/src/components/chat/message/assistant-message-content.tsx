import { ErrorPrimitive, MessagePrimitive, type PartState, useAuiState } from "@assistant-ui/react";
import AlertCircle from "lucide-react/dist/esm/icons/circle-alert.mjs";
import { useMemo } from "react";
import { useThinkingVisibility } from "../../../state/thinking-visibility.tsx";
import { StreamdownText } from "../../assistant-ui/streamdown/streamdown-text.tsx";
import {
  createRunGroupPart,
  hasFinalResponseInRun,
  hasTextAfterGroup,
  hasUserMessageAfter,
} from "../message-part-grouping.ts";
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
  const hasNewUserPrompt = useAuiState((state) => hasUserMessageAfter(state.thread.messages, state.message.id));
  const groupMessagePart = useMemo(() => createRunGroupPart(messageParts), [messageParts]);
  const supersededInfoNotificationData = useMemo(
    () => findSupersededInfoNotificationData(messageParts),
    [messageParts],
  );
  const defaultOpenCompletedActivity = !runHasFinalResponse && (showAvatars || !hasNewUserPrompt);
  const hasGroupedRunActivity = useMemo(
    () => messageParts.some((part) => groupMessagePart(part, { toolUIs })[0] === "group-runActivity"),
    [groupMessagePart, messageParts, toolUIs],
  );

  return (
    <div
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
            case "group-runActivity": {
              const hasCollapsibleContent = part.indices.some((index) => {
                const groupedPart = messageParts[index];
                if (!groupedPart) return false;
                if (groupedPart.type === "reasoning") return showThinking;
                return !isNotificationPart(groupedPart);
              });
              const persistentNotifications = part.indices.flatMap((index) => {
                const groupedPart = messageParts[index];
                if (!isNotificationPart(groupedPart) || supersededInfoNotificationData.has(groupedPart.data)) {
                  return [];
                }
                return [<PiNoticeView key={`${messageId}:notification:${index}`} data={groupedPart.data} />];
              });
              return (
                <RunActivityGroup
                  running={isRunActivityRunning}
                  startedAt={runStartedAt}
                  completedAt={runCompletedAt}
                  hasContent={hasCollapsibleContent}
                  defaultOpenWhenComplete={defaultOpenCompletedActivity}
                  stateKey={`${messageId}:run-activity`}
                  persistentContent={persistentNotifications.length > 0 ? persistentNotifications : undefined}
                >
                  {children}
                </RunActivityGroup>
              );
            }
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
              return (
                <div data-aui-quote-selectable="" className="contents">
                  <StreamdownText />
                </div>
              );
            case "reasoning":
              return showThinking ? <StreamdownText /> : null;
            case "tool-call":
              return part.toolUI ?? <ToolView {...part} />;
            case "data":
              if (part.name !== "pi-notice") return part.dataRendererUI;
              return supersededInfoNotificationData.has(part.data) ? null : <PiNoticeView data={part.data} />;
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

function findSupersededInfoNotificationData(parts: readonly PartState[]): ReadonlySet<unknown> {
  const superseded = new Set<unknown>();
  for (let index = 0; index < parts.length - 1; index += 1) {
    const current = parts[index];
    const next = parts[index + 1];
    if (isInfoNotificationPart(current) && isInfoNotificationPart(next)) superseded.add(current.data);
  }
  return superseded;
}

function isNotificationPart(part: PartState | undefined): part is PartState & {
  readonly type: "data";
  readonly name: "pi-notice";
  readonly data: { readonly noticeType: "notification"; readonly notificationType?: unknown };
} {
  if (part?.type !== "data" || part.name !== "pi-notice") return false;
  const data = part.data;
  return !!data && typeof data === "object" && "noticeType" in data && data.noticeType === "notification";
}

function isInfoNotificationPart(part: PartState | undefined): part is PartState & {
  readonly type: "data";
  readonly name: "pi-notice";
  readonly data: { readonly noticeType: "notification"; readonly notificationType: "info" };
} {
  return isNotificationPart(part) && part.data.notificationType === "info";
}

function piCompletedAt(custom: unknown): number | undefined {
  if (!custom || typeof custom !== "object" || !("pi" in custom)) return undefined;
  const pi = custom.pi;
  if (!pi || typeof pi !== "object" || !("completedAt" in pi)) return undefined;
  return typeof pi.completedAt === "number" && Number.isFinite(pi.completedAt) ? pi.completedAt : undefined;
}
