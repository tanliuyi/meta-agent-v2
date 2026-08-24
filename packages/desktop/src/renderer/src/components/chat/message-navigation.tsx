import type { VirtualItem } from "@tanstack/react-virtual";
import { type PointerEvent, type RefObject, useCallback, useRef, useState } from "react";
import { MessageNavigationItem } from "./message-navigation-item.tsx";

const MESSAGE_NAVIGATION_ITEM_HEIGHT_PX = 6;
const MESSAGE_NAVIGATION_ITEM_GAP_PX = 3;
const MESSAGE_NAVIGATION_ITEM_STRIDE_PX = MESSAGE_NAVIGATION_ITEM_HEIGHT_PX + MESSAGE_NAVIGATION_ITEM_GAP_PX;
const MESSAGE_NAVIGATION_HOVER_RADIUS_PX = 14;

interface MessageNavigationProps {
  scrollerRef: RefObject<HTMLDivElement | null>;
  turnCount: number;
  virtualItems: readonly VirtualItem[];
  getMessageIds(index: number): readonly string[];
  onSelect(index: number): void;
}

export function sampleMessageNavigationIndexes(turnCount: number, maxItems: number, requiredIndex: number): number[] {
  const count = Math.max(0, Math.floor(turnCount));
  const limit = Math.max(3, Math.floor(maxItems));
  if (count <= limit) return Array.from({ length: count }, (_value, index) => index);

  const indexes = Array.from({ length: limit }, (_value, slot) => Math.round((slot * (count - 1)) / (limit - 1)));
  const required = Math.min(count - 1, Math.max(0, Math.floor(requiredIndex)));
  if (!indexes.includes(required)) {
    let replacementSlot = 1;
    let replacementDistance = Number.POSITIVE_INFINITY;
    for (let slot = 1; slot < limit - 1; slot += 1) {
      const distance = Math.abs((indexes[slot] ?? 0) - required);
      if (distance >= replacementDistance) continue;
      replacementSlot = slot;
      replacementDistance = distance;
    }
    indexes[replacementSlot] = required;
    indexes.sort((left, right) => left - right);
  }
  return indexes;
}

export function MessageNavigation({
  scrollerRef,
  turnCount,
  virtualItems,
  getMessageIds,
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
  const navigationHeight = Math.max(96, (scroller?.clientHeight ?? 800) - 56);
  let firstVisible = 0;
  for (const item of virtualItems) {
    if (item.index < turnCount && item.end >= viewportStart && item.start <= viewportEnd) {
      firstVisible = item.index;
      break;
    }
  }

  const maxNavigationItems = Math.max(
    3,
    Math.floor((navigationHeight + MESSAGE_NAVIGATION_ITEM_GAP_PX) / MESSAGE_NAVIGATION_ITEM_STRIDE_PX),
  );
  const navigationIndexes = sampleMessageNavigationIndexes(turnCount, maxNavigationItems, firstVisible);
  const hoveredSlot = hoveredIndex === null ? null : navigationIndexes.indexOf(hoveredIndex);

  const updateHoveredIndex = (event: PointerEvent<HTMLDivElement>) => {
    const height = event.currentTarget.clientHeight;
    const itemsHeight =
      navigationIndexes.length * MESSAGE_NAVIGATION_ITEM_HEIGHT_PX +
      (navigationIndexes.length - 1) * MESSAGE_NAVIGATION_ITEM_GAP_PX;
    const itemsTop = (height - itemsHeight) / 2;
    const pointerY = event.clientY - navigationTopRef.current - itemsTop;
    const nearestSlot = Math.min(
      navigationIndexes.length - 1,
      Math.max(0, Math.round((pointerY - MESSAGE_NAVIGATION_ITEM_HEIGHT_PX / 2) / MESSAGE_NAVIGATION_ITEM_STRIDE_PX)),
    );
    const nearestCenterY = nearestSlot * MESSAGE_NAVIGATION_ITEM_STRIDE_PX + MESSAGE_NAVIGATION_ITEM_HEIGHT_PX / 2;
    const nearestDistance = Math.abs(pointerY - nearestCenterY);

    setHoveredIndexIfChanged(
      nearestDistance <= MESSAGE_NAVIGATION_HOVER_RADIUS_PX ? (navigationIndexes[nearestSlot] ?? null) : null,
    );
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
        {navigationIndexes.map((index, slot) => {
          const active = index === firstVisible;
          const hoverDistance = hoveredSlot === null ? null : Math.abs(slot - hoveredSlot);
          return (
            <MessageNavigationItem
              key={index}
              index={index}
              active={active}
              current={index === firstVisible}
              hovered={hoverDistance === 0}
              hoverDistance={hoverDistance !== null && hoverDistance <= 5 ? hoverDistance : null}
              messageIds={getMessageIds(index)}
              workspace={workspace}
              onSelect={onSelect}
            />
          );
        })}
      </div>
    </nav>
  );
}
