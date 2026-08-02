import { ThreadPrimitive, useAuiState } from "@assistant-ui/react";
import { defaultRangeExtractor, elementScroll, type Range, useVirtualizer } from "@tanstack/react-virtual";
import ArrowDown from "lucide-react/dist/esm/icons/arrow-down.mjs";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ReasoningDisclosureStateProvider } from "../assistant-ui/reasoning/reasoning-disclosure-state.tsx";
import { TooltipIconButton } from "../assistant-ui/tooltip-icon-button.tsx";
import { useSessionControlSelector, useSessionScope, useSessionTimelineSelector } from "../session-context.tsx";
import { AssistantMessage } from "./message/assistant-message.tsx";
import { UserMessage } from "./message/user-message.tsx";
import { SessionThreadActivity } from "./session-thread-activity.tsx";
import { isThreadActivityVisible } from "./thread-activity-indicator.tsx";
import {
  buildThreadTurns,
  mergeSelectedVirtualIndexes,
  stabilizeThreadTurnIds,
  type ThreadMessageRow,
  type ThreadTurn,
} from "./thread-virtualization.ts";

const MESSAGE_COMPONENTS = {
  Message: AssistantMessage,
  UserMessage,
  AssistantMessage,
};
const ESTIMATED_TURN_HEIGHT = 200;
const ACTIVITY_ESTIMATED_HEIGHT = 40;
const AT_BOTTOM_THRESHOLD = 4;
const SESSION_ACTIVITY_KEY = "desktop-session-activity";

interface MessageSelectionRange {
  start: number;
  end: number;
}

export function Messages() {
  const messageRows = useThreadMessageRows();
  const turns = useThreadTurns(messageRows);
  const isRunning = useAuiState((state) => state.thread.isRunning);
  const sessionRecord = useSessionScope().record;
  const sessionKey = sessionRecord.key;
  const phase = useSessionTimelineSelector((timeline) => timeline.phase);
  const lastError = useSessionControlSelector((control) => control?.lastError);
  const activityVisible = isThreadActivityVisible(phase, lastError);
  const activityIndex = turns.length;
  const itemCount = turns.length + Number(activityVisible);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const virtualContentRef = useRef<HTMLDivElement>(null);
  const stickyRef = useRef(true);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [selectionRange, setSelectionRange] = useState<MessageSelectionRange | null>(null);
  const getItemKey = useCallback(
    (index: number) => (activityVisible && index === turns.length ? SESSION_ACTIVITY_KEY : (turns[index]?.id ?? index)),
    [activityVisible, turns],
  );
  const rangeExtractor = useCallback(
    (range: Range) => {
      const indexes = defaultRangeExtractor(range);
      return selectionRange ? mergeSelectedVirtualIndexes(indexes, selectionRange, range.count) : indexes;
    },
    [selectionRange],
  );
  const virtualizer = useVirtualizer({
    count: itemCount,
    estimateSize: (index) => (index === activityIndex ? ACTIVITY_ESTIMATED_HEIGHT : ESTIMATED_TURN_HEIGHT),
    getItemKey,
    getScrollElement: () => scrollerRef.current,
    initialRect: { height: 800, width: 800 },
    overscan: 6,
    rangeExtractor,
    scrollToFn: (offset, options, instance) => {
      const element = instance.scrollElement;
      if (!element) return;
      if (stickyRef.current) {
        const maxScroll = element.scrollHeight - element.clientHeight;
        const targetOffset = offset + (options.adjustments ?? 0);
        if (maxScroll - element.scrollTop <= AT_BOTTOM_THRESHOLD && targetOffset < maxScroll) return;
      }
      elementScroll(offset, options, instance);
    },
  });
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => {
    const element = instance.elementsCache.get(item.key);
    const scrollElement = instance.scrollElement;
    if (!element || !scrollElement) return item.end <= (instance.scrollOffset ?? 0);
    return element.getBoundingClientRect().bottom <= scrollElement.getBoundingClientRect().top;
  };

  const jumpToBottom = useCallback(() => {
    stickyRef.current = true;
    if (itemCount > 0) virtualizer.scrollToIndex(itemCount - 1, { align: "end" });
    requestAnimationFrame(() => {
      const element = scrollerRef.current;
      if (element && stickyRef.current) element.scrollTop = element.scrollHeight;
    });
  }, [itemCount, virtualizer]);

  useEffect(() => {
    const element = scrollerRef.current;
    if (!element) return;
    let lastScrollTop = element.scrollTop;
    let lastScrollHeight = element.scrollHeight;
    let lastClientHeight = element.clientHeight;
    const onScroll = () => {
      const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight <= AT_BOTTOM_THRESHOLD;
      if (atBottom) stickyRef.current = true;
      else if (
        element.scrollTop < lastScrollTop &&
        element.scrollHeight === lastScrollHeight &&
        Math.abs(element.clientHeight - lastClientHeight) <= 1
      ) {
        stickyRef.current = false;
      }
      lastScrollTop = element.scrollTop;
      lastScrollHeight = element.scrollHeight;
      lastClientHeight = element.clientHeight;
      setIsAtBottom(atBottom);
    };
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) stickyRef.current = false;
    };
    const disarm = () => {
      stickyRef.current = false;
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    element.addEventListener("wheel", onWheel, { passive: true });
    element.addEventListener("touchmove", disarm, { passive: true });
    return () => {
      element.removeEventListener("scroll", onScroll);
      element.removeEventListener("wheel", onWheel);
      element.removeEventListener("touchmove", disarm);
    };
  }, []);

  useLayoutEffect(() => {
    const element = scrollerRef.current;
    const threadRoot = element?.parentElement;
    if (!element || !threadRoot) return;
    const syncScrollbarWidth = () => {
      threadRoot.style.setProperty("--thread-scrollbar-width", `${element.offsetWidth - element.clientWidth}px`);
    };
    syncScrollbarWidth();
    const observer = new ResizeObserver(syncScrollbarWidth);
    observer.observe(element);
    return () => {
      observer.disconnect();
      threadRoot.style.removeProperty("--thread-scrollbar-width");
    };
  }, []);

  useEffect(() => {
    const element = scrollerRef.current;
    const content = contentRef.current;
    if (!element || !content) return;
    const observer = new ResizeObserver(() => {
      if (stickyRef.current) element.scrollTop = element.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const updateSelectionRange = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) {
        setSelectionRange(null);
        return;
      }
      const turnIndex = (node: Node | null): number | undefined => {
        const element = node instanceof Element ? node : node?.parentElement;
        const row = element?.closest<HTMLElement>("[data-index]");
        if (!row || !virtualContentRef.current?.contains(row)) return undefined;
        const index = Number(row.dataset.index);
        return Number.isInteger(index) ? index : undefined;
      };
      const anchor = turnIndex(selection.anchorNode);
      const focus = turnIndex(selection.focusNode);
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

  const previousIsRunningRef = useRef(false);
  useLayoutEffect(() => {
    if (isRunning && !previousIsRunningRef.current && stickyRef.current) jumpToBottom();
    previousIsRunningRef.current = isRunning;
  }, [isRunning, jumpToBottom]);

  const didInitialJumpRef = useRef(false);
  useLayoutEffect(() => {
    if (didInitialJumpRef.current || turns.length === 0) return;
    didInitialJumpRef.current = true;
    jumpToBottom();
  }, [jumpToBottom, turns.length]);

  const items = virtualizer.getVirtualItems();
  const paddingTop = items[0]?.start ?? 0;
  const paddingBottom = Math.max(0, virtualizer.getTotalSize() - (items.at(-1)?.end ?? 0));

  return (
    <ReasoningDisclosureStateProvider key={sessionKey} store={sessionRecord.stores.disclosure}>
      <div
        ref={scrollerRef}
        data-slot="aui_thread-viewport"
        className="relative min-h-0 flex-1 overflow-x-hidden overflow-y-scroll overscroll-contain"
      >
        <div
          ref={contentRef}
          data-slot="session-message-content"
          className="mx-auto w-full max-w-(--layout-thread-max-width)"
        >
          <div ref={virtualContentRef} style={{ paddingTop, paddingBottom }}>
            {items.map((item) => {
              if (activityVisible && item.index === activityIndex) {
                return (
                  <div
                    key={item.key}
                    ref={virtualizer.measureElement}
                    data-index={item.index}
                    data-slot="session-thread-activity-row"
                    className="flow-root"
                  >
                    <SessionThreadActivity />
                  </div>
                );
              }
              const turn = turns[item.index];
              if (!turn) return null;
              return (
                <div
                  key={item.key}
                  ref={virtualizer.measureElement}
                  data-index={item.index}
                  data-slot="aui-turn"
                  className="flow-root"
                >
                  {turn.messageIds.map((messageId) => (
                    <ThreadPrimitive.Unstable_MessageById
                      key={messageId}
                      messageId={messageId}
                      components={MESSAGE_COMPONENTS}
                    />
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <div className="pointer-events-none relative z-(--stack-sticky-control) h-0 w-full">
        <TooltipIconButton
          tooltip="滚动到底部"
          side="top"
          variant="outline"
          disabled={isAtBottom}
          onClick={jumpToBottom}
          className="aui-thread-scroll-to-bottom dark:border-border dark:bg-background dark:hover:bg-accent pointer-events-auto absolute right-1/2 bottom-[calc(var(--thread-composer-overlap)+var(--space-7))] translate-x-1/2 rounded-full p-4 disabled:invisible"
        >
          <ArrowDown />
        </TooltipIconButton>
      </div>
    </ReasoningDisclosureStateProvider>
  );
}

function useThreadMessageRows(): readonly ThreadMessageRow[] {
  const previousRowsRef = useRef<readonly ThreadMessageRow[]>([]);
  return useAuiState((state) => {
    const messages = state.thread.messages;
    const previous = previousRowsRef.current;
    if (
      previous.length === messages.length &&
      previous.every((row, index) => {
        const message = messages[index];
        return message !== undefined && row.id === message.id && row.role === message.role;
      })
    ) {
      return previous;
    }
    const next = messages.map(({ id, role }) => ({ id, role }));
    previousRowsRef.current = next;
    return next;
  });
}

function useThreadTurns(messageRows: readonly ThreadMessageRow[]): readonly ThreadTurn[] {
  const previousTurnsRef = useRef<readonly ThreadTurn[]>([]);
  const turns = useMemo(
    () => stabilizeThreadTurnIds(previousTurnsRef.current, buildThreadTurns(messageRows)),
    [messageRows],
  );
  useLayoutEffect(() => {
    previousTurnsRef.current = turns;
  }, [turns]);
  return turns;
}
