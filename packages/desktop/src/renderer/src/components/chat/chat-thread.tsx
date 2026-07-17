import { ThreadPrimitive } from "@assistant-ui/react";
import { ArrowDown, MessageSquarePlus } from "lucide-react";
import { type CSSProperties, useLayoutEffect, useRef } from "react";
import { useDesktop } from "../../state/desktop-context.tsx";
import { TooltipIconButton } from "../assistant-ui/tooltip-icon-button.tsx";
import { Composer } from "./composer.tsx";
import { HostRequests } from "./host-requests.tsx";
import { Messages } from "./messages.tsx";
import { SessionStatus } from "./session-status.tsx";
import { followThreadSwitchToBottom } from "./thread-switch-bottom-follow.ts";

/** 中央聊天工作区。 */
export function ChatThread() {
  const desktop = useDesktop();
  const { project, bootstrap, snapshot } = desktop;
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const threadId = bootstrap?.threadId ?? null;
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!threadId || !viewport || !content) return;
    return followThreadSwitchToBottom(viewport, content);
  }, [threadId]);
  if (desktop.draft) {
    const draftProject = desktop.projects.find(({ id }) => id === desktop.draft?.projectId) ?? null;
    return (
      <ThreadPrimitive.Root
        className="thread-root aui-root aui-thread-root @container flex h-full flex-col bg-background"
        style={THREAD_STYLE}
      >
        <div className="min-h-0 flex-1" />
        <div className="thread-footer relative shrink-0 bg-background">
          <div className="relative mx-auto flex w-full max-w-(--thread-max-width) flex-col gap-2 px-4 pb-4">
            <Composer
              mode="draft"
              projects={desktop.projects}
              project={draftProject}
              config={desktop.draft.config}
              configLoading={desktop.draft.configLoading}
              phase={desktop.draft.phase}
              onProjectChange={desktop.selectDraftProject}
              onModelChange={desktop.selectDraftModel}
              onThinkingChange={desktop.selectDraftThinking}
              onSubmit={desktop.submitDraft}
            />
          </div>
        </div>
      </ThreadPrimitive.Root>
    );
  }
  if (!project) return <Empty title="打开一个 Project" detail="选择本地工作区后，Pi 会在对应 cwd 中运行。" />;
  if (!bootstrap || !snapshot) {
    return <Empty title="准备新会话" detail="正在初始化 Composer。" />;
  }
  return (
    <>
      <ThreadPrimitive.Root
        className="thread-root aui-root aui-thread-root @container flex h-full flex-col bg-background"
        style={THREAD_STYLE}
      >
        <ThreadPrimitive.Viewport
          ref={viewportRef}
          turnAnchor="top"
          scrollToBottomOnThreadSwitch={false}
          data-slot="aui_thread-viewport"
          className="relative flex flex-1 flex-col overflow-x-auto overflow-y-scroll scroll-smooth"
        >
          <div ref={contentRef} className="mx-auto flex w-full max-w-(--thread-max-width) flex-1 flex-col px-4 pt-4">
            <div data-slot="aui_message-group" className="mb-14 flex flex-col gap-y-6 empty:hidden">
              <Messages />
            </div>
            <ThreadPrimitive.ViewportFooter className="aui-thread-viewport-footer sticky bottom-0 mt-auto flex flex-col gap-2 overflow-visible rounded-t-(--composer-radius) bg-background pb-4">
              <ThreadPrimitive.ScrollToBottom asChild>
                <TooltipIconButton
                  tooltip="滚动到底部"
                  side="top"
                  variant="outline"
                  className="aui-thread-scroll-to-bottom dark:border-border dark:bg-background dark:hover:bg-accent absolute -top-12 z-10 self-center rounded-full p-4 disabled:invisible"
                >
                  <ArrowDown />
                </TooltipIconButton>
              </ThreadPrimitive.ScrollToBottom>
              <SessionStatus snapshot={snapshot} />
              <Composer mode="session" snapshot={snapshot} />
            </ThreadPrimitive.ViewportFooter>
          </div>
        </ThreadPrimitive.Viewport>
      </ThreadPrimitive.Root>
      <HostRequests snapshot={snapshot} />
    </>
  );
}

const THREAD_STYLE = {
  "--thread-max-width": "44rem",
  "--composer-bg": "color-mix(in oklab, var(--color-muted) 30%, var(--color-background))",
  "--composer-radius": "1.5rem",
  "--composer-padding": "8px",
} as CSSProperties;

function Empty({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="empty-state">
      <div className="empty-icon">
        <MessageSquarePlus size={22} />
      </div>
      <h2>{title}</h2>
      <p>{detail}</p>
    </div>
  );
}
