import { ThreadPrimitive, useAuiState } from "@assistant-ui/react";
import { AssistantMessage } from "./message/assistant-message.tsx";
import { UserMessage } from "./message/user-message.tsx";

export function Messages() {
  const isRunning = useAuiState((state) => state.thread.isRunning);
  return (
    <ThreadPrimitive.Messages>
      {({ message }) =>
        message.role === "user" ? (
          <UserMessage />
        ) : (
          <AssistantMessage isRunActivityRunning={isRunning && message.isLast} />
        )
      }
    </ThreadPrimitive.Messages>
  );
}
