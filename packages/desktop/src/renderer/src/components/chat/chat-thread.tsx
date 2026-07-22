import { useSessionConnection, useSessionControl, useSessionScope } from "../session-context.tsx";
import { EmptyChatState } from "./empty-chat-state.tsx";
import { SessionChatThread } from "./session-chat-thread.tsx";

/** Cached real-session chat surface. Draft rendering remains outside this record-owned component. */
export function ChatThread() {
  const { record } = useSessionScope();
  const control = useSessionControl();
  const connection = useSessionConnection();
  if (connection === "error") return <EmptyChatState title="会话连接失败" detail="请重试或返回其他会话。" />;
  if (!control) return <EmptyChatState title="正在连接会话" detail="正在加载 Pi session。" />;
  return <SessionChatThread threadId={record.identity.threadId} />;
}
