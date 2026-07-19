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
  commitViewportClamp?: boolean;
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
 * 以 DOM CSS 变量承载拖拽瞬态值，pointer move 通过 RAF 合并更新且不触发 React render。
 *
 * 持久化只发生在拖拽结束、键盘操作或启用了提交的视口 clamp 时。
 */
export function useResizableRegion<T extends HTMLElement>(options: ResizableRegionOptions): ResizableRegionBinding<T> {
  const optionsRef = useRef(options);
  const regionRef = useRef<T>(null);
  const separatorRef = useRef<HTMLDivElement>(null);
  const currentSizeRef = useRef(limitSize(options.value, options.min, options.getMaxSize()));
  const pendingSizeRef = useRef(currentSizeRef.current);
  const frameRef = useRef<number | null>(null);
  const cleanupPointerRef = useRef<(() => void) | null>(null);
  optionsRef.current = options;

  const applySize = useCallback((requestedSize: number) => {
    const currentOptions = optionsRef.current;
    const max = currentOptions.getMaxSize();
    const size = limitSize(requestedSize, currentOptions.min, max);
    currentSizeRef.current = size;
    pendingSizeRef.current = size;
    regionRef.current?.style.setProperty(REGION_SIZE_PROPERTY, `${size}px`);
    separatorRef.current?.setAttribute("aria-valuemax", String(Math.round(Math.max(currentOptions.min, max))));
    separatorRef.current?.setAttribute("aria-valuenow", String(size));
    separatorRef.current?.setAttribute("aria-valuetext", `${size} 像素`);
    return size;
  }, []);

  const scheduleSize = useCallback(
    (requestedSize: number) => {
      pendingSizeRef.current = requestedSize;
      if (frameRef.current !== null) return;
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        applySize(pendingSizeRef.current);
      });
    },
    [applySize],
  );

  const flushPendingSize = useCallback(() => {
    if (frameRef.current === null) return currentSizeRef.current;
    cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    return applySize(pendingSizeRef.current);
  }, [applySize]);

  useLayoutEffect(() => {
    applySize(options.value);
  }, [applySize, options.value]);

  useEffect(() => {
    const clampToViewport = () => {
      const currentOptions = optionsRef.current;
      const previous = currentSizeRef.current;
      const next = applySize(currentOptions.commitViewportClamp === false ? currentOptions.value : previous);
      if (currentOptions.commitViewportClamp !== false && next !== previous) currentOptions.onCommit(next);
    };
    window.addEventListener("resize", clampToViewport);
    return () => window.removeEventListener("resize", clampToViewport);
  }, [applySize]);

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
      const separator = event.currentTarget;
      const pointerId = event.pointerId;
      const move = (nextEvent: PointerEvent) => {
        const point = horizontal ? nextEvent.clientY : nextEvent.clientX;
        scheduleSize(startSize + (point - startPoint) * currentOptions.direction);
      };
      const stop = () => {
        cleanupPointerRef.current?.();
        optionsRef.current.onCommit(flushPendingSize());
      };
      const cleanup = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", stop);
        window.removeEventListener("pointercancel", stop);
        if (separator.hasPointerCapture(pointerId)) separator.releasePointerCapture(pointerId);
        cleanupPointerRef.current = null;
        document.body.classList.remove(horizontal ? "is-resizing-row" : "is-resizing-column");
      };
      cleanupPointerRef.current = cleanup;
      separator.setPointerCapture(pointerId);
      document.body.classList.add(horizontal ? "is-resizing-row" : "is-resizing-column");
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", stop, { once: true });
      window.addEventListener("pointercancel", stop, { once: true });
    },
    [flushPendingSize, scheduleSize],
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
      const size = applySize(next);
      currentOptions.onCommit(size);
    },
    [applySize],
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
