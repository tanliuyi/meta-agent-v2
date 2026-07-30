import { useSessionConnection, useSessionControlSelector } from "../session-context.tsx";
import { EmptyChatState } from "./empty-chat-state.tsx";
import { SessionBootstrapPendingThread } from "./session-bootstrap-pending-thread.tsx";
import { SessionChatThread } from "./session-chat-thread.tsx";

/** Cached real-session chat surface. Draft rendering remains outside this record-owned component. */
export function ChatThread() {
  const hasControl = useSessionControlSelector((control) => control !== null);
  const connection = useSessionConnection();
  if (connection === "error") return <EmptyChatState title="会话连接失败" detail="请重试或返回其他会话。" />;
  if (!hasControl) return <SessionBootstrapPendingThread />;
  return <SessionChatThread />;
}
