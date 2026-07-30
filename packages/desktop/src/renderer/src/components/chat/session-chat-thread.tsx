import { ThreadPrimitive } from "@assistant-ui/react";
import { useRef } from "react";
import { Messages } from "./messages.tsx";
import { SelectionToolbar } from "./selection-toolbar.tsx";
import { SessionComposer } from "./session-composer.tsx";
import { SessionHostRequests } from "./session-host-requests.tsx";

/**
 * Holds the assistant-ui thread viewport and the session message tree.
 * Desktop control updates are independently subscribed by leaf components.
 */
export function SessionChatThread() {
  const viewportRef = useRef<HTMLDivElement>(null);

  return (
    <>
      <ThreadPrimitive.Root className="thread-root aui-root aui-thread-root @container flex h-full flex-col overflow-hidden bg-background">
        <ThreadPrimitive.Viewport
          ref={viewportRef}
          autoScroll={false}
          scrollToBottomOnInitialize={false}
          scrollToBottomOnRunStart={false}
          scrollToBottomOnThreadSwitch={false}
          data-slot="aui_thread-viewport"
          className="relative min-h-0 flex-1 overflow-x-hidden overflow-y-scroll"
        >
          <div className="mx-auto w-full max-w-(--layout-thread-max-width) px-4">
            <Messages viewportRef={viewportRef} />
          </div>
        </ThreadPrimitive.Viewport>
        <div
          data-slot="session-composer-footer"
          className="w-full shrink-0 bg-[linear-gradient(to_bottom,transparent,var(--color-background)_16px)] pt-2"
        >
          <div className="mx-auto w-full max-w-(--layout-thread-max-width) px-4 pb-4">
            <SessionComposer />
          </div>
        </div>
        <SelectionToolbar />
      </ThreadPrimitive.Root>
      <SessionHostRequests />
    </>
  );
}
