import { MessagePrimitive, useAuiState } from "@assistant-ui/react";
import { useEffect, useState } from "react";
import { useSessionScope } from "../../session-context.tsx";
import { AssistantMessageActionBar } from "./assistant-message-action-bar.tsx";
import { AssistantMessageContent } from "./assistant-message-content.tsx";

export function AssistantMessage() {
  const threadRunning = useAuiState((state) => state.thread.isRunning);
  const isLast = useAuiState((state) => state.message.isLast);
  const messageRunning = useAuiState((state) => isPiAssistantRunning(state.message.metadata.custom));
  const runActivity = useSessionScope().record.stores.runActivity;
  const [participatedInRun, setParticipatedInRun] = useState(() => messageRunning || runActivity.hasParticipated());

  useEffect(() => {
    if (!threadRunning) runActivity.reset();
    else if (messageRunning) runActivity.markParticipated();
    setParticipatedInRun((current) => reduceRunActivityParticipation(current, threadRunning, messageRunning));
  }, [messageRunning, runActivity, threadRunning]);

  const isRunActivityRunning = threadRunning && isLast && (messageRunning || participatedInRun);
  return (
    <MessagePrimitive.Root
      data-slot="aui-assistant-message-root"
      data-role="assistant"
      className="fade-in slide-in-from-bottom-1 animate-in relative -mb-7 pb-7 duration-150 [contain-intrinsic-size:auto_200px] [content-visibility:auto]"
    >
      <AssistantMessageContent isRunActivityRunning={isRunActivityRunning} isMessageRunning={messageRunning} />
      <AssistantMessageActionBar />
    </MessagePrimitive.Root>
  );
}

export function isPiAssistantRunning(custom: unknown): boolean {
  if (!custom || typeof custom !== "object" || !("pi" in custom)) return false;
  const pi = custom.pi;
  if (!pi || typeof pi !== "object" || !("status" in pi)) return false;
  const status = pi.status;
  return Boolean(status && typeof status === "object" && "type" in status && status.type === "running");
}

export function reduceRunActivityParticipation(
  current: boolean,
  threadRunning: boolean,
  messageRunning: boolean,
): boolean {
  if (!threadRunning) return false;
  if (messageRunning) return true;
  return current;
}
