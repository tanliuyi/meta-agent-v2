import { cn } from "@renderer/shared/lib/cn";
import { type PointerEvent, useCallback, useRef, useState, type WheelEvent } from "react";

const MIN_SCALE = 0.25;
const MAX_SCALE = 10;
const WHEEL_ZOOM_SPEED = 0.002;

type Position = {
  x: number;
  y: number;
};

type ViewTransform = Position & {
  scale: number;
};

const INITIAL_TRANSFORM: ViewTransform = { x: 0, y: 0, scale: 1 };

export function AttachmentPreview({ src }: { src: string }) {
  const imageRef = useRef<HTMLImageElement>(null);
  const transformRef = useRef(INITIAL_TRANSFORM);
  const dragRef = useRef<(Position & { pointerId: number; originX: number; originY: number }) | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [transform, setTransform] = useState(INITIAL_TRANSFORM);

  const updateTransform = useCallback((next: ViewTransform) => {
    transformRef.current = next;
    setTransform(next);
  }, []);

  const handleLoad = useCallback(() => {
    setIsLoaded(true);
    updateTransform(INITIAL_TRANSFORM);
  }, [updateTransform]);

  const handleWheel = useCallback(
    (event: WheelEvent<HTMLDivElement>) => {
      const image = imageRef.current;
      if (!image) return;

      event.preventDefault();
      const current = transformRef.current;
      const nextScale = Math.min(
        MAX_SCALE,
        Math.max(MIN_SCALE, current.scale * Math.exp(-event.deltaY * WHEEL_ZOOM_SPEED)),
      );
      if (nextScale === current.scale) return;

      const imageRect = image.getBoundingClientRect();
      const ratio = nextScale / current.scale;
      updateTransform({
        scale: nextScale,
        x: current.x + (event.clientX - imageRect.left) * (1 - ratio),
        y: current.y + (event.clientY - imageRect.top) * (1 - ratio),
      });
    },
    [updateTransform],
  );

  const handlePointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !imageRef.current) return;

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const current = transformRef.current;
    dragRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      originX: current.x,
      originY: current.y,
    };
    setIsDragging(true);
  }, []);

  const handlePointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;

      updateTransform({
        ...transformRef.current,
        x: drag.originX + event.clientX - drag.x,
        y: drag.originY + event.clientY - drag.y,
      });
    },
    [updateTransform],
  );

  const stopDragging = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setIsDragging(false);
  }, []);

  const zoomed = transform.scale !== 1;

  return (
    <div
      onWheel={handleWheel}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={stopDragging}
      onPointerCancel={stopDragging}
      className={cn(
        "aui-attachment-preview relative flex h-full w-full touch-none select-none items-center justify-center overflow-hidden",
        isLoaded && (isDragging ? "cursor-grabbing" : "cursor-grab"),
      )}
    >
      {zoomed ? (
        <div className="pointer-events-none fixed bottom-4 left-1/2 z-10 -translate-x-1/2 rounded-md bg-background/80 px-2 py-1 text-xs font-medium tabular-nums text-muted-foreground shadow-(--elevation-popover) backdrop-blur-sm">
          {Math.round(transform.scale * 100)}%
        </div>
      ) : null}
      <img
        ref={imageRef}
        src={src}
        alt="Attachment preview"
        draggable={false}
        className={cn(
          "block h-auto max-h-[calc(100dvh-2rem)] w-auto max-w-[calc(100vw-2rem)] object-contain will-change-transform",
          isLoaded ? "aui-attachment-preview-image-loaded" : "aui-attachment-preview-image-loading invisible",
        )}
        style={{
          transform: `translate3d(${transform.x}px, ${transform.y}px, 0) scale(${transform.scale})`,
          transformOrigin: "top left",
        }}
        onLoad={handleLoad}
      />
    </div>
  );
}
