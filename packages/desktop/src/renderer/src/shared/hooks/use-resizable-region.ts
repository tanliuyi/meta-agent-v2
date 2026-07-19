import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";

interface ResizableRegionOptions {
  value: number;
  min: number;
  getMaxSize(): number;
  direction: 1 | -1;
  orientation: "horizontal" | "vertical";
  onCommit(value: number): void;
}

interface ResizableRegionBinding<T extends HTMLElement> {
  regionRef: RefObject<T | null>;
  separatorRef: RefObject<HTMLDivElement | null>;
  initialSize: number;
  initialMax: number;
  onPointerDown(event: ReactPointerEvent<HTMLDivElement>): void;
  onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void;
}

const REGION_SIZE_PROPERTY = "--resizable-region-size";

/**
 * 以 DOM CSS 变量承载拖拽瞬态值，pointer move 不触发 React render。
 *
 * 持久化只发生在拖拽结束、键盘操作或视口 clamp 时。
 */
export function useResizableRegion<T extends HTMLElement>(options: ResizableRegionOptions): ResizableRegionBinding<T> {
  const optionsRef = useRef(options);
  const regionRef = useRef<T>(null);
  const separatorRef = useRef<HTMLDivElement>(null);
  const currentSizeRef = useRef(limitSize(options.value, options.min, options.getMaxSize()));
  const pendingSizeRef = useRef(currentSizeRef.current);
  const frameRef = useRef<number | null>(null);
  const commitOnFrameRef = useRef(false);
  const cleanupPointerRef = useRef<(() => void) | null>(null);
  optionsRef.current = options;

  const scheduleSize = useCallback((requestedSize: number, commitOnFrame = false) => {
    const currentOptions = optionsRef.current;
    const next = limitSize(requestedSize, currentOptions.min, currentOptions.getMaxSize());
    currentSizeRef.current = next;
    pendingSizeRef.current = next;
    commitOnFrameRef.current ||= commitOnFrame;
    if (frameRef.current !== null) return next;

    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      const latestOptions = optionsRef.current;
      const max = latestOptions.getMaxSize();
      const size = limitSize(pendingSizeRef.current, latestOptions.min, max);
      currentSizeRef.current = size;
      regionRef.current?.style.setProperty(REGION_SIZE_PROPERTY, `${size}px`);
      separatorRef.current?.setAttribute("aria-valuemax", String(Math.round(Math.max(latestOptions.min, max))));
      separatorRef.current?.setAttribute("aria-valuenow", String(size));
      separatorRef.current?.setAttribute("aria-valuetext", `${size} 像素`);
      if (commitOnFrameRef.current) latestOptions.onCommit(size);
      commitOnFrameRef.current = false;
    });
    return next;
  }, []);

  useLayoutEffect(() => {
    scheduleSize(options.value);
  }, [options.value, scheduleSize]);

  useEffect(() => {
    const clampToViewport = () => {
      const currentOptions = optionsRef.current;
      const previous = currentSizeRef.current;
      const next = limitSize(previous, currentOptions.min, currentOptions.getMaxSize());
      scheduleSize(next, next !== previous);
    };
    window.addEventListener("resize", clampToViewport);
    return () => window.removeEventListener("resize", clampToViewport);
  }, [scheduleSize]);

  useEffect(
    () => () => {
      cleanupPointerRef.current?.();
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      cleanupPointerRef.current?.();
      const currentOptions = optionsRef.current;
      const horizontal = currentOptions.orientation === "horizontal";
      const startPoint = horizontal ? event.clientY : event.clientX;
      const startSize = currentSizeRef.current;
      const move = (nextEvent: PointerEvent) => {
        const point = horizontal ? nextEvent.clientY : nextEvent.clientX;
        scheduleSize(startSize + (point - startPoint) * currentOptions.direction);
      };
      const stop = () => {
        cleanupPointerRef.current?.();
        optionsRef.current.onCommit(currentSizeRef.current);
      };
      const cleanup = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", stop);
        window.removeEventListener("pointercancel", stop);
        cleanupPointerRef.current = null;
        document.body.classList.remove(horizontal ? "is-resizing-row" : "is-resizing-column");
      };
      cleanupPointerRef.current = cleanup;
      document.body.classList.add(horizontal ? "is-resizing-row" : "is-resizing-column");
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", stop, { once: true });
      window.addEventListener("pointercancel", stop, { once: true });
    },
    [scheduleSize],
  );

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const currentOptions = optionsRef.current;
      const horizontal = currentOptions.orientation === "horizontal";
      const backward = horizontal ? event.key === "ArrowUp" : event.key === "ArrowLeft";
      const forward = horizontal ? event.key === "ArrowDown" : event.key === "ArrowRight";
      if (!backward && !forward && event.key !== "Home" && event.key !== "End") return;
      event.preventDefault();
      const next =
        event.key === "Home"
          ? currentOptions.min
          : event.key === "End"
            ? currentOptions.getMaxSize()
            : currentSizeRef.current + (backward ? -16 : 16) * currentOptions.direction;
      const size = scheduleSize(next);
      currentOptions.onCommit(size);
    },
    [scheduleSize],
  );

  const initialMax = Math.max(options.min, options.getMaxSize());
  return {
    regionRef,
    separatorRef,
    initialSize: limitSize(options.value, options.min, initialMax),
    initialMax: Math.round(initialMax),
    onPointerDown,
    onKeyDown,
  };
}

/** 将持久化或拖拽尺寸限制在当前视口允许范围内。 */
export function limitSize(value: number, min: number, max: number): number {
  return Math.round(Math.min(Math.max(value, min), Math.max(min, max)));
}
