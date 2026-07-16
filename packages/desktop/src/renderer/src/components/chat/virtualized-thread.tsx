import { ThreadPrimitive, useAuiState } from "@assistant-ui/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown } from "lucide-react";
import { type RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { SessionControlState } from "../../../../shared/contracts.ts";
import { TooltipIconButton } from "../assistant-ui/tooltip-icon-button.tsx";
import { Composer } from "./composer.tsx";
import { MessageEntranceAnimationProvider, MessageProcessGroup, THREAD_MESSAGE_COMPONENTS } from "./messages.tsx";
import { SessionStatus } from "./session-status.tsx";
import {
  buildThreadTurns,
  didUserScrollUp,
  isScrollerAtBottom,
  partitionThreadTurn,
  projectThreadMessageRows,
  resolveThreadScrollState,
  type ScrollerMetrics,
  stabilizeThreadTurnIds,
  type ThreadMessageRow,
  type ThreadTurn,
} from "./thread-virtualization.ts";

const ESTIMATED_TURN_HEIGHT = 200;
const AT_BOTTOM_THRESHOLD = 8;

// assistant-ui 当前只通过这个 experimental API 提供稳定 ID 的虚拟消息渲染。
const VirtualizedMessageById = ThreadPrimitive.Unstable_MessageById;

interface ThreadScrollController {
  jumpToBottom(): void;
}

export function VirtualizedThreadSurface({
  sessionKey,
  snapshot,
}: {
  sessionKey: string;
  snapshot: SessionControlState;
}) {
  const controllerRef = useRef<ThreadScrollController | null>(null);
  const [scrollState, setScrollState] = useState({ sessionKey, isAtBottom: true });
  const handleAtBottomChange = useCallback(
    (isAtBottom: boolean) => setScrollState({ sessionKey, isAtBottom }),
    [sessionKey],
  );
  const showScrollToBottom = scrollState.sessionKey === sessionKey && !scrollState.isAtBottom;
  return (
    <>
      <VirtualizedThreadScroller
        key={sessionKey}
        controllerRef={controllerRef}
        onAtBottomChange={handleAtBottomChange}
      />
      <ThreadFooter
        snapshot={snapshot}
        showScrollToBottom={showScrollToBottom}
        onScrollToBottom={() => controllerRef.current?.jumpToBottom()}
      />
    </>
  );
}

function VirtualizedThreadScroller({
  controllerRef,
  onAtBottomChange,
}: {
  controllerRef: RefObject<ThreadScrollController | null>;
  onAtBottomChange(value: boolean): void;
}) {
  const rows = useThreadMessageRows();
  const isRunning = useAuiState((state) => state.thread.isRunning);
  const runStartedAtRef = useRef<number | null>(isRunning ? Date.now() : null);
  const [lastRunDurationMs, setLastRunDurationMs] = useState<number>();
  const turns = useThreadTurns(rows);
  const messageIds = useMemo(() => rows.map(({ id }) => id), [rows]);
  const roleByMessageId = useMemo(() => new Map(rows.map(({ id, role }) => [id, role])), [rows]);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const stickyRef = useRef(true);
  const programmaticScrollRef = useRef(false);
  const atBottomRef = useRef(true);

  useEffect(() => {
    if (isRunning) {
      if (runStartedAtRef.current === null) {
        runStartedAtRef.current = Date.now();
        setLastRunDurationMs(undefined);
      }
      return;
    }
    if (runStartedAtRef.current !== null) {
      setLastRunDurationMs(Date.now() - runStartedAtRef.current);
      runStartedAtRef.current = null;
    }
  }, [isRunning]);

  const updateAtBottom = useCallback(
    (value: boolean) => {
      if (atBottomRef.current === value) return;
      atBottomRef.current = value;
      onAtBottomChange(value);
    },
    [onAtBottomChange],
  );

  const virtualizer = useVirtualizer({
    count: turns.length,
    estimateSize: () => ESTIMATED_TURN_HEIGHT,
    getItemKey: (index) => turns[index]!.id,
    getScrollElement: () => scrollerRef.current,
    anchorTo: "end",
    followOnAppend: true,
    scrollEndThreshold: AT_BOTTOM_THRESHOLD,
    overscan: 4,
  });

  const jumpToBottom = useCallback(() => {
    stickyRef.current = true;
    programmaticScrollRef.current = true;
    if (turns.length > 0) {
      virtualizer.scrollToIndex(turns.length - 1, { align: "end" });
    } else {
      updateAtBottom(true);
    }
    requestAnimationFrame(() => {
      programmaticScrollRef.current = false;
    });
  }, [turns.length, updateAtBottom, virtualizer]);

  useLayoutEffect(() => {
    controllerRef.current = { jumpToBottom };
    return () => {
      controllerRef.current = null;
    };
  }, [controllerRef, jumpToBottom]);

  useEffect(() => {
    const element = scrollerRef.current;
    if (!element) return;
    let previous = readScrollerMetrics(element);
    const onScroll = () => {
      const current = readScrollerMetrics(element);
      const state = resolveThreadScrollState({
        wasPinned: stickyRef.current,
        physicallyAtBottom: isScrollerAtBottom(current, AT_BOTTOM_THRESHOLD),
        userScrolledUp: !programmaticScrollRef.current && didUserScrollUp(previous, current),
      });
      stickyRef.current = state.pinned;
      previous = current;
      updateAtBottom(state.atBottom);
    };
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) stickyRef.current = false;
    };
    const onTouchMove = () => {
      stickyRef.current = false;
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    element.addEventListener("wheel", onWheel, { passive: true });
    element.addEventListener("touchmove", onTouchMove, { passive: true });
    return () => {
      element.removeEventListener("scroll", onScroll);
      element.removeEventListener("wheel", onWheel);
      element.removeEventListener("touchmove", onTouchMove);
    };
  }, [updateAtBottom]);

  const previousIsRunningRef = useRef(isRunning);
  useLayoutEffect(() => {
    if (isRunning && !previousIsRunningRef.current) jumpToBottom();
    previousIsRunningRef.current = isRunning;
  }, [isRunning, jumpToBottom]);

  const didInitialJumpRef = useRef(false);
  const viewportHeight = virtualizer.scrollRect?.height ?? 0;
  useLayoutEffect(() => {
    if (didInitialJumpRef.current || turns.length === 0 || viewportHeight === 0) return;
    didInitialJumpRef.current = true;
    jumpToBottom();
  }, [jumpToBottom, turns.length, viewportHeight]);

  const items = virtualizer.getVirtualItems();
  const paddingTop = items[0]?.start ?? 0;
  const paddingBottom = Math.max(0, virtualizer.getTotalSize() - (items.at(-1)?.end ?? 0));

  return (
    <MessageEntranceAnimationProvider isRunning={isRunning} messageIds={messageIds}>
      <div
        ref={scrollerRef}
        data-slot="thread-scroller"
        className="thread-scroller min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain [overflow-anchor:none]"
      >
        <div className="mx-auto w-full max-w-(--thread-max-width) px-4">
          <div data-slot="aui-message-group" className="empty:hidden" style={{ paddingTop, paddingBottom }}>
            {items.map((item) => {
              const turn = turns[item.index]!;
              const sections = partitionThreadTurn(turn, roleByMessageId);
              const isLatestTurn = item.index === turns.length - 1;
              return (
                <div
                  key={item.key}
                  ref={virtualizer.measureElement}
                  data-index={item.index}
                  data-slot="aui-turn"
                  className="flex flex-col py-3"
                >
                  {sections.leadingMessageIds.map((messageId) => (
                    <VirtualizedMessageById
                      key={messageId}
                      messageId={messageId}
                      components={THREAD_MESSAGE_COMPONENTS}
                    />
                  ))}
                  {sections.processMessageIds.length > 0 ? (
                    <MessageProcessGroup
                      durationMs={isLatestTurn ? lastRunDurationMs : undefined}
                      isRunning={isRunning && isLatestTurn}
                    >
                      {sections.processMessageIds.map((messageId) => (
                        <VirtualizedMessageById
                          key={messageId}
                          messageId={messageId}
                          components={THREAD_MESSAGE_COMPONENTS}
                        />
                      ))}
                    </MessageProcessGroup>
                  ) : null}
                  {sections.answerMessageIds.map((messageId) => (
                    <VirtualizedMessageById
                      key={messageId}
                      messageId={messageId}
                      components={THREAD_MESSAGE_COMPONENTS}
                    />
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </MessageEntranceAnimationProvider>
  );
}

function ThreadFooter({
  snapshot,
  showScrollToBottom,
  onScrollToBottom,
}: {
  snapshot: SessionControlState;
  showScrollToBottom: boolean;
  onScrollToBottom(): void;
}) {
  return (
    <div className="thread-footer relative shrink-0 bg-background">
      <div className="relative mx-auto flex w-full max-w-(--thread-max-width) flex-col gap-2 px-4 pb-4">
        <ThreadScrollToBottom visible={showScrollToBottom} onClick={onScrollToBottom} />
        <SessionStatus snapshot={snapshot} />
        <Composer mode="session" snapshot={snapshot} />
      </div>
    </div>
  );
}

function ThreadScrollToBottom({ visible, onClick }: { visible: boolean; onClick(): void }) {
  if (!visible) return null;
  return (
    <TooltipIconButton
      tooltip="滚动到底部"
      side="top"
      variant="outline"
      className="absolute -top-12 left-1/2 z-10 -translate-x-1/2 rounded-full bg-background shadow-sm"
      onClick={onClick}
    >
      <ArrowDown />
    </TooltipIconButton>
  );
}

function useThreadMessageRows(): readonly ThreadMessageRow[] {
  const cacheRef = useRef<{
    messages: readonly ThreadMessageRow[] | undefined;
    rows: readonly ThreadMessageRow[];
  }>({ messages: undefined, rows: [] });
  return useAuiState((state) => {
    const messages = state.thread.messages;
    const cached = cacheRef.current;
    if (cached.messages === messages) return cached.rows;
    const rows = projectThreadMessageRows(cached.rows, messages);
    cacheRef.current = { messages, rows };
    return rows;
  });
}

function useThreadTurns(rows: readonly ThreadMessageRow[]): readonly ThreadTurn[] {
  const previousTurnsRef = useRef<readonly ThreadTurn[]>([]);
  const turns = useMemo(() => stabilizeThreadTurnIds(previousTurnsRef.current, buildThreadTurns(rows)), [rows]);
  useLayoutEffect(() => {
    previousTurnsRef.current = turns;
  }, [turns]);
  return turns;
}

function readScrollerMetrics(element: HTMLDivElement): ScrollerMetrics {
  return {
    scrollTop: element.scrollTop,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
  };
}
