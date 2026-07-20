import { useDesktopSelector } from "../../state/desktop-context.tsx";
import { selectActiveBootstrap, selectActiveThreadId } from "../../state/desktop-selectors.ts";
import { DraftChatThread } from "./draft-chat-thread.tsx";
import { EmptyChatState } from "./empty-chat-state.tsx";
import { SessionChatThread } from "./session-chat-thread.tsx";

/** 只按工作区模式和 active session identity 路由聊天表面。 */
export function ChatThread() {
  const isDraft = useDesktopSelector((state) => state.draft !== null);
  const projectId = useDesktopSelector((state) => state.project?.id ?? null);
  const threadId = useDesktopSelector(selectActiveThreadId);
  const hasBootstrap = useDesktopSelector((state) => selectActiveBootstrap(state) !== null);
  const loading = useDesktopSelector((state) => state.loading);

  if (isDraft) return <DraftChatThread />;
  if (loading && !projectId) return <EmptyChatState title="正在初始化" detail="正在加载 Project。" />;
  if (!projectId) return <EmptyChatState title="打开一个 Project" detail="" />;
  if (!threadId || !hasBootstrap) return <EmptyChatState title="准备新会话" detail="正在初始化 Composer。" />;
  return <SessionChatThread threadId={threadId} />;
}
