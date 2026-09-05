import { ThreadPrimitive } from "@assistant-ui/react";
import { useRef } from "react";
import { Messages } from "./messages.tsx";
import { SelectionToolbar } from "./selection-toolbar.tsx";
import { SessionComposer } from "./session-composer.tsx";

/**
 * Holds the assistant-ui thread viewport and the session message tree.
 * Desktop control updates are independently subscribed by leaf components.
 */
export function SessionChatThread() {
  const threadRootRef = useRef<HTMLDivElement>(null);
  return (
    <>
      <ThreadPrimitive.Root
        ref={threadRootRef}
        className="thread-root aui-root aui-thread-root @container flex h-full flex-col overflow-hidden bg-background"
      >
        <Messages />
        <div
          data-slot="session-composer-footer"
          className="shrink-0 bg-[linear-gradient(to_bottom,transparent,var(--color-background)_var(--thread-composer-overlap))] pr-(--thread-scrollbar-width) overscroll-contain"
        >
          <div data-slot="session-composer-content" className="mx-auto w-full max-w-(--layout-thread-max-width) pb-4">
            <SessionComposer />
          </div>
        </div>
        <SelectionToolbar rootRef={threadRootRef} />
      </ThreadPrimitive.Root>
    </>
  );
}
