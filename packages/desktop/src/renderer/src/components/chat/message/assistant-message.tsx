import { MessagePrimitive, useAuiState } from "@assistant-ui/react";
import { AssistantMessageActionBar } from "./assistant-message-action-bar.tsx";
import { AssistantMessageContent } from "./assistant-message-content.tsx";

export function AssistantMessage() {
  const isRunActivityRunning = useAuiState((state) => state.thread.isRunning && state.message.isLast);
  return (
    <MessagePrimitive.Root
      data-slot="aui-assistant-message-root"
      data-role="assistant"
      className="fade-in slide-in-from-bottom-1 animate-in relative -mb-7 pb-7 duration-150 [contain-intrinsic-size:auto_200px] [content-visibility:auto]"
    >
      <AssistantMessageContent isRunActivityRunning={isRunActivityRunning} />
      <AssistantMessageActionBar />
    </MessagePrimitive.Root>
  );
}
