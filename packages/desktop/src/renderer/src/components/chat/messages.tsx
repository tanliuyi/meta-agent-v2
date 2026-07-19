import { ThreadPrimitive } from "@assistant-ui/react";
import { AssistantMessage } from "./message/assistant-message.tsx";
import { UserMessage } from "./message/user-message.tsx";

export function Messages() {
  return (
    <ThreadPrimitive.Messages>
      {({ message }) => (message.role === "user" ? <UserMessage /> : <AssistantMessage />)}
    </ThreadPrimitive.Messages>
  );
}
