import { ThreadPrimitive } from "@assistant-ui/react";
import ArrowDown from "lucide-react/dist/esm/icons/arrow-down.mjs";
import { useLayoutEffect, useRef } from "react";
import { TooltipIconButton } from "../assistant-ui/tooltip-icon-button.tsx";
import { Messages } from "./messages.tsx";
import { SessionComposer } from "./session-composer.tsx";
import { SessionHostRequests } from "./session-host-requests.tsx";
import { SessionThreadActivity } from "./session-thread-activity.tsx";
import { followThreadSwitchToBottom } from "./thread-switch-bottom-follow.ts";

interface SessionChatThreadProps {
  threadId: string;
}

/**
 * 持有 assistant-ui 原生 Thread viewport 与历史消息树。
 * Desktop control 更新由独立叶子组件订阅，不经过本组件或 Messages。
 */
export function SessionChatThread({ threadId }: SessionChatThreadProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    return followThreadSwitchToBottom(viewport, content);
  }, [threadId]);

  return (
    <>
      <ThreadPrimitive.Root className="thread-root aui-root aui-thread-root @container flex h-full flex-col bg-background">
        <ThreadPrimitive.Viewport
          ref={viewportRef}
          turnAnchor="bottom"
          scrollToBottomOnThreadSwitch={false}
          data-slot="aui_thread-viewport"
          className="relative flex flex-1 flex-col overflow-x-hidden overflow-y-scroll scroll-smooth"
        >
          <div
            ref={contentRef}
            className="mx-auto flex w-full max-w-(--layout-thread-max-width) flex-1 flex-col px-4 pt-4"
          >
            <div data-slot="aui_message-group" className="mb-14 flex flex-col empty:hidden">
              <Messages />
              <SessionThreadActivity />
            </div>
            <ThreadPrimitive.ViewportFooter className="aui-thread-viewport-footer sticky bottom-0 mt-auto flex flex-col gap-2 overflow-visible pb-4">
              <ThreadPrimitive.ScrollToBottom asChild>
                <TooltipIconButton
                  tooltip="滚动到底部"
                  side="top"
                  variant="outline"
                  className="aui-thread-scroll-to-bottom dark:border-border dark:bg-background dark:hover:bg-accent absolute -top-12 z-(--stack-sticky-control) self-center rounded-full p-4 disabled:invisible"
                >
                  <ArrowDown />
                </TooltipIconButton>
              </ThreadPrimitive.ScrollToBottom>
              <SessionComposer />
            </ThreadPrimitive.ViewportFooter>
          </div>
        </ThreadPrimitive.Viewport>
      </ThreadPrimitive.Root>
      <SessionHostRequests />
    </>
  );
}
