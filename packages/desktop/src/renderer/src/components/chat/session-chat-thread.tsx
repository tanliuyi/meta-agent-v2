import { ThreadPrimitive } from "@assistant-ui/react";
import ArrowDown from "lucide-react/dist/esm/icons/arrow-down.mjs";
import { TooltipIconButton } from "../assistant-ui/tooltip-icon-button.tsx";
import { Messages } from "./messages.tsx";
import { SelectionToolbar } from "./selection-toolbar.tsx";
import { SessionComposer } from "./session-composer.tsx";
import { SessionHostRequests } from "./session-host-requests.tsx";
import { SessionThreadActivity } from "./session-thread-activity.tsx";

/**
 * Holds the assistant-ui thread viewport and the session message tree.
 * Desktop control updates are independently subscribed by leaf components.
 */
export function SessionChatThread() {
  return (
    <>
      <ThreadPrimitive.Root className="thread-root aui-root aui-thread-root @container flex h-full flex-col overflow-hidden bg-background">
        <ThreadPrimitive.Viewport
          scrollToBottomOnInitialize
          data-slot="aui_thread-viewport"
          className="relative flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-scroll scroll-smooth"
        >
          <div className="mx-auto flex min-h-full w-full max-w-(--layout-thread-max-width) flex-1 flex-col px-4 pt-4">
            <div data-slot="aui_message-group" className="mb-14 flex flex-col empty:hidden">
              <Messages />
              <SessionThreadActivity />
            </div>
            <ThreadPrimitive.ViewportFooter className="aui-thread-viewport-footer flex-shrink-0 pointer-events-auto sticky bottom-0 mt-auto flex w-full flex-col gap-2 overflow-visible bg-[linear-gradient(to_bottom,transparent,var(--color-background))] pb-4">
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
        <SelectionToolbar />
      </ThreadPrimitive.Root>
      <SessionHostRequests />
    </>
  );
}
