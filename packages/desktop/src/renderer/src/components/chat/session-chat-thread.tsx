import { ThreadPrimitive } from "@assistant-ui/react";
import ArrowDown from "lucide-react/dist/esm/icons/arrow-down.mjs";
import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { TooltipIconButton } from "../assistant-ui/tooltip-icon-button.tsx";
import { observeComposerOverlayHeight } from "./composer-overlay-height.ts";
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
  const rootRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);
  const [footerHost, setFooterHost] = useState<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    return followThreadSwitchToBottom(viewport, content);
  }, [threadId]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    const viewport = viewportRef.current;
    const footer = footerRef.current;
    if (!footerHost || !root || !viewport || !footer) return;
    return observeComposerOverlayHeight(root, viewport, footer);
  }, [footerHost]);

  return (
    <>
      <ThreadPrimitive.Root
        ref={rootRef}
        className="thread-root aui-root aui-thread-root @container relative flex h-full flex-col overflow-hidden bg-background"
      >
        <ThreadPrimitive.Viewport
          ref={viewportRef}
          turnAnchor="bottom"
          scrollToBottomOnThreadSwitch={false}
          data-slot="aui_thread-viewport"
          className="relative flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-scroll scroll-smooth"
        >
          <div
            ref={contentRef}
            className="mx-auto flex min-h-full w-full max-w-(--layout-thread-max-width) shrink-0 flex-col px-4 pt-4 pb-[var(--composer-overlay-height,0px)]"
          >
            <div data-slot="aui_message-group" className="mb-14 flex flex-col empty:hidden">
              <Messages />
              <SessionThreadActivity />
            </div>
          </div>
          {footerHost
            ? createPortal(
                <ThreadPrimitive.ViewportFooter
                  ref={footerRef}
                  className="aui-thread-viewport-footer pointer-events-auto relative mx-auto flex w-full max-w-(--layout-thread-max-width) flex-col gap-2 overflow-visible px-4 pb-4"
                >
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
                </ThreadPrimitive.ViewportFooter>,
                footerHost,
              )
            : null}
        </ThreadPrimitive.Viewport>
        <div
          ref={setFooterHost}
          className="pointer-events-none absolute inset-x-0 bottom-0 z-(--stack-sticky-control)"
        />
      </ThreadPrimitive.Root>
      <SessionHostRequests />
    </>
  );
}
