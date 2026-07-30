import { ThreadPrimitive, unstable_useThreadMessageIds } from "@assistant-ui/react";
import { defaultRangeExtractor, type Range, useVirtualizer } from "@tanstack/react-virtual";
import ArrowDown from "lucide-react/dist/esm/icons/arrow-down.mjs";
import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { TooltipIconButton } from "../assistant-ui/tooltip-icon-button.tsx";
import { useSessionControlSelector, useSessionScope, useSessionTimelineSelector } from "../session-context.tsx";
import { AssistantMessage } from "./message/assistant-message.tsx";
import { UserMessage } from "./message/user-message.tsx";
import { SessionThreadActivity } from "./session-thread-activity.tsx";
import { isThreadActivityVisible } from "./thread-activity-indicator.tsx";

const MESSAGE_COMPONENTS = {
  Message: AssistantMessage,
  UserMessage,
  AssistantMessage,
};
const MESSAGE_ESTIMATED_HEIGHT = 400;
const MESSAGE_PADDING = 16;
const MESSAGE_END_OVERFLOW = 28;
const ACTIVITY_ESTIMATED_HEIGHT = 40;
const SCROLL_END_THRESHOLD = 80;
const SESSION_ACTIVITY_KEY = "desktop-session-activity";

interface MessageSelectionRange {
  start: number;
  end: number;
}

export function Messages({ viewportRef }: { viewportRef: RefObject<HTMLDivElement | null> }) {
  const messageIds = unstable_useThreadMessageIds();
  const sessionKey = useSessionScope().record.key;
  const phase = useSessionTimelineSelector((timeline) => timeline.phase);
  const lastError = useSessionControlSelector((control) => control?.lastError);
  const activityVisible = isThreadActivityVisible(phase, lastError);
  const activityIndex = messageIds.length;
  const containerRef = useRef<HTMLDivElement>(null);
  const initialScrollKeyRef = useRef<string | null>(null);
  const previousCountRef = useRef(0);
  const [selectionRange, setSelectionRange] = useState<MessageSelectionRange | null>(null);
  const getItemKey = useCallback(
    (index: number) =>
      activityVisible && index === messageIds.length ? SESSION_ACTIVITY_KEY : (messageIds[index] ?? index),
    [activityVisible, messageIds],
  );
  const rangeExtractor = useCallback(
    (range: Range) => {
      const indexes = defaultRangeExtractor(range);
      if (!selectionRange) return indexes;
      const selected = Array.from(
        { length: selectionRange.end - selectionRange.start + 1 },
        (_, offset) => selectionRange.start + offset,
      );
      return [...new Set([...indexes, ...selected])].sort((left, right) => left - right);
    },
    [selectionRange],
  );
  const endPadding = MESSAGE_END_OVERFLOW;
  const itemCount = messageIds.length + Number(activityVisible);
  const virtualizer = useVirtualizer({
    count: itemCount,
    getScrollElement: () => viewportRef.current,
    estimateSize: (index) => (index === activityIndex ? ACTIVITY_ESTIMATED_HEIGHT : MESSAGE_ESTIMATED_HEIGHT),
    getItemKey,
    rangeExtractor,
    paddingStart: MESSAGE_PADDING,
    paddingEnd: endPadding,
    scrollPaddingEnd: endPadding,
    anchorTo: "end",
    followOnAppend: true,
    scrollEndThreshold: SCROLL_END_THRESHOLD,
    overscan: 1,
    directDomUpdates: true,
    directDomUpdatesMode: "position",
    useFlushSync: false,
  });
  const setContainer = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node) virtualizer.elementsCache.clear();
      containerRef.current = node;
      virtualizer.containerRef(node);
    },
    [virtualizer],
  );

  useEffect(() => {
    const updateSelectionRange = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) {
        setSelectionRange(null);
        return;
      }
      const messageIndex = (node: Node | null): number | undefined => {
        const element = node instanceof Element ? node : node?.parentElement;
        const row = element?.closest<HTMLElement>("[data-index]");
        if (!row || !containerRef.current?.contains(row)) return undefined;
        const index = Number(row.dataset.index);
        return Number.isInteger(index) ? index : undefined;
      };
      const anchor = messageIndex(selection.anchorNode);
      const focus = messageIndex(selection.focusNode);
      const startIndex = anchor ?? focus;
      const endIndex = focus ?? anchor;
      if (startIndex === undefined || endIndex === undefined) {
        setSelectionRange(null);
        return;
      }
      const start = Math.min(startIndex, endIndex);
      const end = Math.max(startIndex, endIndex);
      setSelectionRange((current) => (current?.start === start && current.end === end ? current : { start, end }));
    };
    document.addEventListener("selectionchange", updateSelectionRange);
    return () => document.removeEventListener("selectionchange", updateSelectionRange);
  }, []);

  useLayoutEffect(() => {
    const previousCount = previousCountRef.current;
    previousCountRef.current = itemCount;
    if (initialScrollKeyRef.current !== sessionKey || itemCount === previousCount) return;
    if (virtualizer.getDistanceFromEnd() <= SCROLL_END_THRESHOLD) virtualizer.scrollToEnd();
  }, [itemCount, sessionKey, virtualizer]);

  useLayoutEffect(() => {
    if (initialScrollKeyRef.current === sessionKey || messageIds.length === 0 || !virtualizer.scrollElement) return;
    virtualizer.scrollToEnd();
    initialScrollKeyRef.current = sessionKey;
  }, [messageIds.length, sessionKey, virtualizer, virtualizer.scrollElement]);

  return (
    <>
      <div ref={setContainer} className="relative w-full">
        {virtualizer.getVirtualItems().map((virtualItem) => {
          if (activityVisible && virtualItem.index === activityIndex) {
            return (
              <div
                key={virtualItem.key}
                ref={virtualizer.measureElement}
                data-index={virtualItem.index}
                data-slot="session-thread-activity-row"
                className="absolute left-0 w-full flow-root"
              >
                <SessionThreadActivity />
              </div>
            );
          }
          const messageId = messageIds[virtualItem.index];
          if (!messageId) return null;
          return (
            <div
              key={virtualItem.key}
              ref={virtualizer.measureElement}
              data-index={virtualItem.index}
              className="absolute left-0 w-full flow-root"
            >
              <ThreadPrimitive.Unstable_MessageById messageId={messageId} components={MESSAGE_COMPONENTS} />
            </div>
          );
        })}
      </div>
      <div className="pointer-events-none sticky bottom-4 z-(--stack-sticky-control) h-0 w-full">
        <TooltipIconButton
          tooltip="滚动到底部"
          side="top"
          variant="outline"
          disabled={virtualizer.isAtEnd()}
          onClick={() => virtualizer.scrollToEnd()}
          className="aui-thread-scroll-to-bottom dark:border-border dark:bg-background dark:hover:bg-accent pointer-events-auto absolute bottom-0 left-1/2 -translate-x-1/2 rounded-full p-4 disabled:invisible"
        >
          <ArrowDown />
        </TooltipIconButton>
      </div>
    </>
  );
}
