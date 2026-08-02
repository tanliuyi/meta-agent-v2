import type { VirtualItem } from "@tanstack/react-virtual";
import { type PointerEvent, type RefObject, useCallback, useRef, useState } from "react";
import { MessageNavigationItem } from "./message-navigation-item.tsx";

const MESSAGE_NAVIGATION_ITEM_HEIGHT_PX = 6;
const MESSAGE_NAVIGATION_ITEM_GAP_PX = 3;
const MESSAGE_NAVIGATION_ITEM_STRIDE_PX = MESSAGE_NAVIGATION_ITEM_HEIGHT_PX + MESSAGE_NAVIGATION_ITEM_GAP_PX;
const MESSAGE_NAVIGATION_HOVER_RADIUS_PX = 14;
const EMPTY_MESSAGE_NAVIGATION_SUMMARY: readonly MessageNavigationSummary[] = [];

export interface MessageNavigationSummary {
  markdown: boolean;
  text: string;
}

interface MessageNavigationProps {
  scrollerRef: RefObject<HTMLDivElement | null>;
  turnCount: number;
  virtualItems: readonly VirtualItem[];
  getSummary(index: number): readonly MessageNavigationSummary[];
  onSelect(index: number): void;
}

export function MessageNavigation({
  scrollerRef,
  turnCount,
  virtualItems,
  getSummary,
  onSelect,
}: MessageNavigationProps) {
  const scroller = scrollerRef.current;
  const workspace = scroller?.closest<HTMLElement>(".chat-workspace") ?? null;
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const hoveredIndexRef = useRef<number | null>(null);
  const navigationTopRef = useRef(0);
  const setHoveredIndexIfChanged = useCallback((index: number | null) => {
    if (hoveredIndexRef.current === index) return;
    hoveredIndexRef.current = index;
    setHoveredIndex(index);
  }, []);

  if (turnCount < 2) return null;

  const viewportStart = scroller?.scrollTop ?? 0;
  const viewportEnd = viewportStart + (scroller?.clientHeight ?? 0);
  const navigationHeight = scroller ? Math.max(96, scroller.clientHeight - 56) : undefined;
  let firstVisible = 0;
  for (const item of virtualItems) {
    if (item.index < turnCount && item.end >= viewportStart && item.start <= viewportEnd) {
      firstVisible = item.index;
      break;
    }
  }

  const updateHoveredIndex = (event: PointerEvent<HTMLDivElement>) => {
    const height = event.currentTarget.clientHeight;
    const itemsHeight =
      turnCount * MESSAGE_NAVIGATION_ITEM_HEIGHT_PX + (turnCount - 1) * MESSAGE_NAVIGATION_ITEM_GAP_PX;
    const itemsTop = (height - itemsHeight) / 2;
    const pointerY = event.clientY - navigationTopRef.current - itemsTop;
    const nearestIndex = Math.min(
      turnCount - 1,
      Math.max(0, Math.round((pointerY - MESSAGE_NAVIGATION_ITEM_HEIGHT_PX / 2) / MESSAGE_NAVIGATION_ITEM_STRIDE_PX)),
    );
    const nearestCenterY = nearestIndex * MESSAGE_NAVIGATION_ITEM_STRIDE_PX + MESSAGE_NAVIGATION_ITEM_HEIGHT_PX / 2;
    const nearestDistance = Math.abs(pointerY - nearestCenterY);

    setHoveredIndexIfChanged(nearestDistance <= MESSAGE_NAVIGATION_HOVER_RADIUS_PX ? nearestIndex : null);
  };

  const selectHoveredIndex = () => {
    if (hoveredIndex !== null) onSelect(hoveredIndex);
  };

  return (
    <nav className="message-navigation" aria-label="消息导航">
      <div
        className="message-navigation-items"
        data-hovering={hoveredIndex !== null ? "true" : undefined}
        style={{ height: navigationHeight }}
        onPointerEnter={(event) => {
          navigationTopRef.current = event.currentTarget.getBoundingClientRect().top;
          updateHoveredIndex(event);
        }}
        onPointerMove={updateHoveredIndex}
        onPointerLeave={() => setHoveredIndexIfChanged(null)}
        onClick={selectHoveredIndex}
      >
        {Array.from({ length: turnCount }, (_, index) => {
          const active = index === firstVisible;
          const hoverDistance = hoveredIndex === null ? null : Math.abs(index - hoveredIndex);
          const summary = hoverDistance === 0 ? getSummary(index) : EMPTY_MESSAGE_NAVIGATION_SUMMARY;
          return (
            <MessageNavigationItem
              key={index}
              index={index}
              active={active}
              current={index === firstVisible}
              hovered={hoverDistance === 0}
              hoverDistance={hoverDistance !== null && hoverDistance <= 5 ? hoverDistance : null}
              summary={summary}
              workspace={workspace}
              onSelect={onSelect}
            />
          );
        })}
      </div>
    </nav>
  );
}
