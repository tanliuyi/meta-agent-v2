import ChevronLeft from "lucide-react/dist/esm/icons/chevron-left.mjs";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right.mjs";
import Plus from "lucide-react/dist/esm/icons/plus.mjs";
import X from "lucide-react/dist/esm/icons/x.mjs";
import {
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type WheelEvent,
} from "react";
import type { CachedSessionRecord } from "../../runtime/pi-session-store.ts";
import { useDesktopSelector } from "../../state/desktop-context.tsx";
import {
  useSessionCache,
  useSessionCacheActiveKey,
  useSessionCacheRecords,
} from "../../state/session-cache-context.tsx";
import { useSessionNavigation } from "../../state/session-navigation.ts";
import { TooltipIconButton } from "../assistant-ui/tooltip-icon-button.tsx";

export type WindowsSessionTabStatus = "blocked" | "running" | "error" | "completed" | "idle";

export interface WindowsSessionTab {
  key: string;
  projectId: string;
  threadId: string;
  title: string;
  status: WindowsSessionTabStatus;
}

const WINDOWS_SESSION_TAB_STATUS_LABELS: Record<Exclude<WindowsSessionTabStatus, "idle">, string> = {
  blocked: "等待用户操作",
  running: "运行中",
  error: "运行错误",
  completed: "运行已完成",
};

export function resolveWindowsSessionTabStatus(input: {
  blocked: boolean;
  running: boolean;
  error: boolean;
  completed: boolean;
  active: boolean;
}): WindowsSessionTabStatus {
  if (input.blocked) return "blocked";
  if (input.running) return "running";
  if (input.error) return "error";
  if (input.completed && !input.active) return "completed";
  return "idle";
}

function useSessionTabStoreSnapshots(records: readonly CachedSessionRecord[]): void {
  const subscribe = useCallback(
    (notify: () => void) => {
      const unsubscribers = records.flatMap((record) => [
        record.stores.control.subscribe(notify),
        record.stores.timeline.subscribe(notify),
      ]);
      return () => {
        for (const unsubscribe of unsubscribers) unsubscribe();
      };
    },
    [records],
  );
  const getSnapshot = useCallback(
    () =>
      records
        .map(
          (record) =>
            `${record.key}:${record.stores.control.getSnapshot()?.revision ?? -1}:${record.stores.timeline.getSnapshot().cursor}`,
        )
        .join("|"),
    [records],
  );
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function nextWindowsSessionTab(
  tabs: readonly WindowsSessionTab[],
  closedIndex: number,
): WindowsSessionTab | undefined {
  return tabs[closedIndex + 1] ?? tabs[closedIndex - 1];
}

export function moveWindowsSessionTab(keys: readonly string[], draggedKey: string, insertIndex: number): string[] {
  if (!keys.includes(draggedKey)) return [...keys];
  const reordered = keys.filter((key) => key !== draggedKey);
  reordered.splice(Math.max(0, Math.min(insertIndex, reordered.length)), 0, draggedKey);
  return reordered;
}

export function WindowsSessionTabs() {
  const cache = useSessionCache();
  const records = useSessionCacheRecords();
  const activeKey = useSessionCacheActiveKey();
  const threadCatalogs = useDesktopSelector((state) => state.threadCatalogs);
  const { openDraft, openSession } = useSessionNavigation();
  const listRef = useRef<HTMLDivElement>(null);
  const tabElementsRef = useRef(new Map<string, HTMLDivElement>());
  const flipPositionsRef = useRef<Map<string, number> | null>(null);
  const pointerDragRef = useRef<{
    key: string;
    pointerId: number;
    startX: number;
    startY: number;
    lastX: number;
    grabOffsetX: number;
    offsetX: number;
    dragging: boolean;
  } | null>(null);
  const suppressActivationRef = useRef(false);
  const [tabOrder, setTabOrder] = useState<string[]>([]);
  const [draggedKey, setDraggedKey] = useState<string | null>(null);
  const [dragOffsetX, setDragOffsetX] = useState(0);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  useSessionTabStoreSnapshots(records);

  const orderedRecords = useMemo(() => {
    const recordsByKey = new Map(records.map((record) => [record.key, record]));
    const ordered = tabOrder.flatMap((key) => {
      const record = recordsByKey.get(key);
      return record ? [record] : [];
    });
    const orderedKeys = new Set(tabOrder);
    return [...ordered, ...records.filter((record) => !orderedKeys.has(record.key))];
  }, [records, tabOrder]);

  useEffect(() => {
    const recordKeys = records.map((record) => record.key);
    const recordKeySet = new Set(recordKeys);
    setTabOrder((current) => {
      const next = [
        ...current.filter((key) => recordKeySet.has(key)),
        ...recordKeys.filter((key) => !current.includes(key)),
      ];
      return next.length === current.length && next.every((key, index) => key === current[index]) ? current : next;
    });
  }, [records]);

  const tabs = useMemo<WindowsSessionTab[]>(
    () =>
      orderedRecords.map((record) => {
        const thread = threadCatalogs[record.identity.projectId]?.find(({ id }) => id === record.identity.threadId);
        const control = record.stores.control.getSnapshot();
        const timeline = record.stores.timeline.getSnapshot();
        const latestAssistant = timeline.nodes.findLast((node) => node.kind === "assistant");
        const running = control?.running ?? thread?.running ?? false;
        return {
          key: record.key,
          projectId: record.identity.projectId,
          threadId: record.identity.threadId,
          title: thread?.title || control?.extensionHost.windowTitle || control?.title || "新会话",
          status: resolveWindowsSessionTabStatus({
            blocked: (control?.hostRequests.length ?? 0) > 0,
            running,
            error:
              !running && latestAssistant?.status.type === "incomplete" && latestAssistant.status.reason === "error",
            completed: thread?.completed === true,
            active: record.key === activeKey,
          }),
        };
      }),
    [activeKey, orderedRecords, threadCatalogs],
  );

  useLayoutEffect(() => {
    const previousPositions = flipPositionsRef.current;
    flipPositionsRef.current = null;
    const drag = pointerDragRef.current;
    if (drag?.dragging) {
      const element = tabElementsRef.current.get(drag.key);
      if (element) {
        const baseLeft = element.getBoundingClientRect().left - drag.offsetX;
        drag.offsetX = drag.lastX - drag.grabOffsetX - baseLeft;
        setDragOffsetX(drag.offsetX);
      }
    }
    if (!previousPositions || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    for (const [key, element] of tabElementsRef.current) {
      if (key === drag?.key) continue;
      const previousLeft = previousPositions.get(key);
      if (previousLeft === undefined) continue;
      const deltaX = previousLeft - element.getBoundingClientRect().left;
      if (Math.abs(deltaX) < 1) continue;
      element.animate([{ transform: `translate3d(${deltaX}px, 0, 0)` }, { transform: "translate3d(0, 0, 0)" }], {
        duration: 160,
        easing: "cubic-bezier(0.2, 0, 0, 1)",
      });
    }
  }, [tabOrder]);

  const updateScrollState = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    setCanScrollLeft(list.scrollLeft > 1);
    setCanScrollRight(list.scrollLeft + list.clientWidth < list.scrollWidth - 1);
  }, []);

  useEffect(() => {
    updateScrollState();
    const list = listRef.current;
    if (!list || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateScrollState);
    observer.observe(list);
    return () => observer.disconnect();
  }, [tabs, updateScrollState]);

  useEffect(() => {
    const activeTab = listRef.current?.querySelector<HTMLElement>('.windows-session-tab-trigger[aria-selected="true"]');
    activeTab?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
  }, [activeKey]);

  const activate = useCallback(
    (tab: WindowsSessionTab) => {
      if (tab.key !== activeKey) void openSession(tab.projectId, tab.threadId);
    },
    [activeKey, openSession],
  );

  const createTask = useCallback(() => {
    const projectId = tabs.find(({ key }) => key === activeKey)?.projectId;
    void openDraft(projectId);
  }, [activeKey, openDraft, tabs]);

  const closeTab = useCallback(
    async (tab: WindowsSessionTab, index: number) => {
      if (tab.key === activeKey) {
        const nextTab = nextWindowsSessionTab(tabs, index);
        if (nextTab) await openSession(nextTab.projectId, nextTab.threadId);
        else await openDraft(tab.projectId);
      }
      await cache.retire(tab.key);
      await window.desktop.sessions.close(tab.projectId, tab.threadId);
    },
    [activeKey, cache, openDraft, openSession, tabs],
  );

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | undefined;
    if (event.key === "ArrowLeft") nextIndex = Math.max(0, index - 1);
    if (event.key === "ArrowRight") nextIndex = Math.min(tabs.length - 1, index + 1);
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = tabs.length - 1;
    if (nextIndex === undefined || nextIndex === index) return;
    event.preventDefault();
    listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[nextIndex]?.focus();
    activate(tabs[nextIndex]!);
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>, key: string) => {
    if (event.button !== 0 || (event.target as Element).closest(".windows-session-tab-close")) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    pointerDragRef.current = {
      key,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      grabOffsetX: event.clientX - bounds.left,
      offsetX: 0,
      dragging: false,
    };
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = pointerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.dragging && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 4) return;
    if (!drag.dragging) {
      drag.dragging = true;
      suppressActivationRef.current = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      setDraggedKey(drag.key);
    }
    event.preventDefault();
    drag.lastX = event.clientX;

    const list = listRef.current;
    const draggedElement = tabElementsRef.current.get(drag.key);
    if (!list || !draggedElement) return;
    const bounds = list.getBoundingClientRect();
    if (event.clientX < bounds.left + 24) list.scrollLeft -= 12;
    else if (event.clientX > bounds.right - 24) list.scrollLeft += 12;

    const baseLeft = bounds.left + draggedElement.offsetLeft - list.scrollLeft;
    drag.offsetX = event.clientX - drag.grabOffsetX - baseLeft;
    setDragOffsetX(drag.offsetX);

    let insertIndex = 0;
    for (const tab of tabs) {
      if (tab.key === drag.key) continue;
      const element = tabElementsRef.current.get(tab.key);
      if (!element) continue;
      const center = bounds.left + element.offsetLeft - list.scrollLeft + element.offsetWidth / 2;
      if (event.clientX > center) insertIndex += 1;
    }
    const current = tabs.map(({ key }) => key);
    const reordered = moveWindowsSessionTab(current, drag.key, insertIndex);
    if (reordered.every((key, index) => key === current[index])) return;
    flipPositionsRef.current = new Map(
      [...tabElementsRef.current].map(([key, element]) => [key, element.getBoundingClientRect().left]),
    );
    setTabOrder(reordered);
  };

  const finishPointerDrag = (event: PointerEvent<HTMLDivElement>) => {
    const drag = pointerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    pointerDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    if (
      drag.dragging &&
      Math.abs(drag.offsetX) >= 1 &&
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      tabElementsRef.current
        .get(drag.key)
        ?.animate([{ transform: `translate3d(${drag.offsetX}px, 0, 0)` }, { transform: "translate3d(0, 0, 0)" }], {
          duration: 160,
          easing: "cubic-bezier(0.2, 0, 0, 1)",
        });
    }
    setDraggedKey(null);
    setDragOffsetX(0);
    if (drag.dragging) {
      window.setTimeout(() => {
        suppressActivationRef.current = false;
      }, 0);
    }
  };

  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    event.currentTarget.scrollLeft += event.deltaY;
  };

  return (
    <nav className="windows-session-tabs" aria-label="已打开的会话">
      {canScrollLeft ? (
        <button
          type="button"
          className="windows-session-tabs-scroll"
          aria-label="向左滚动会话标签"
          title="向左滚动"
          onClick={() => listRef.current?.scrollBy({ left: -180, behavior: "smooth" })}
        >
          <ChevronLeft size={14} />
        </button>
      ) : null}
      <div
        ref={listRef}
        className="windows-session-tabs-list"
        role="tablist"
        aria-label="会话"
        onPointerMove={handlePointerMove}
        onPointerLeave={() => {
          if (!pointerDragRef.current?.dragging) pointerDragRef.current = null;
        }}
        onPointerUp={finishPointerDrag}
        onPointerCancel={finishPointerDrag}
        onLostPointerCapture={finishPointerDrag}
        onScroll={updateScrollState}
        onWheel={handleWheel}
      >
        {tabs.map((tab, index) => {
          const active = tab.key === activeKey;
          return (
            <div
              key={tab.key}
              ref={(element) => {
                if (element) tabElementsRef.current.set(tab.key, element);
                else tabElementsRef.current.delete(tab.key);
              }}
              className="windows-session-tab"
              data-active={active || undefined}
              data-dragging={draggedKey === tab.key || undefined}
              data-tab-index={index}
              style={draggedKey === tab.key ? { transform: `translate3d(${dragOffsetX}px, 0, 0)` } : undefined}
              onPointerDown={(event) => handlePointerDown(event, tab.key)}
            >
              <button
                type="button"
                className="windows-session-tab-trigger"
                role="tab"
                aria-selected={active}
                tabIndex={active || (activeKey === null && index === 0) ? 0 : -1}
                title={tab.title}
                onClick={() => {
                  if (suppressActivationRef.current) return;
                  activate(tab);
                }}
                onKeyDown={(event) => handleKeyDown(event, index)}
              >
                {tab.status !== "idle" ? (
                  <span
                    className={`windows-session-tab-status windows-session-tab-status-${tab.status}`}
                    aria-label={WINDOWS_SESSION_TAB_STATUS_LABELS[tab.status]}
                    title={WINDOWS_SESSION_TAB_STATUS_LABELS[tab.status]}
                  />
                ) : null}
                <span className="windows-session-tab-title">{tab.title}</span>
              </button>
              <TooltipIconButton
                className="windows-session-tab-close size-5! shrink-0"
                tooltip="关闭"
                aria-label={`关闭 ${tab.title}`}
                onClick={() =>
                  void closeTab(tab, index).catch((error: unknown) => console.error("关闭会话失败", error))
                }
              >
                <X size={12} aria-hidden="true" />
              </TooltipIconButton>
            </div>
          );
        })}
        <TooltipIconButton
          className="windows-session-tabs-new size-6! shrink-0"
          tooltip="新建任务"
          aria-label="新建任务"
          onClick={createTask}
        >
          <Plus size={15} aria-hidden="true" />
        </TooltipIconButton>
      </div>
      {canScrollRight ? (
        <button
          type="button"
          className="windows-session-tabs-scroll"
          aria-label="向右滚动会话标签"
          title="向右滚动"
          onClick={() => listRef.current?.scrollBy({ left: 180, behavior: "smooth" })}
        >
          <ChevronRight size={14} />
        </button>
      ) : null}
    </nav>
  );
}
