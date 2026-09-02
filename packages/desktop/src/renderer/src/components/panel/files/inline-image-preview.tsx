import { TooltipIconButton } from "@renderer/components/assistant-ui/tooltip-icon-button";
import RotateCcw from "lucide-react/dist/esm/icons/rotate-ccw.mjs";
import RotateCw from "lucide-react/dist/esm/icons/rotate-cw.mjs";
import Scan from "lucide-react/dist/esm/icons/scan.mjs";
import ZoomIn from "lucide-react/dist/esm/icons/zoom-in.mjs";
import ZoomOut from "lucide-react/dist/esm/icons/zoom-out.mjs";
import { useEffect, useRef, useState } from "react";

const MIN_SCALE = 0.25;
const MAX_SCALE = 10;

interface InlineImagePreviewProps {
  src: string;
  alt: string;
}

export function InlineImagePreview({ src, alt }: InlineImagePreviewProps) {
  const [scale, setScale] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const transformed = scale !== 1 || rotation % 360 !== 0 || offset.x !== 0 || offset.y !== 0;

  useEffect(() => {
    setScale(1);
    setRotation(0);
    setOffset({ x: 0, y: 0 });
  }, [src]);

  const zoomAt = (nextScale: number, clientX?: number, clientY?: number, element?: HTMLDivElement) => {
    const clampedScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, nextScale));
    if (clientX === undefined || clientY === undefined || !element || clampedScale === scale) {
      setScale(clampedScale);
      return;
    }
    const rect = element.getBoundingClientRect();
    const point = {
      x: clientX - rect.left - rect.width / 2,
      y: clientY - rect.top - rect.height / 2,
    };
    const ratio = clampedScale / scale;
    setOffset((current) => ({
      x: point.x - (point.x - current.x) * ratio,
      y: point.y - (point.y - current.y) * ratio,
    }));
    setScale(clampedScale);
  };

  const changeScale = (delta: number) => {
    zoomAt(scale + delta);
  };

  const reset = () => {
    setScale(1);
    setRotation(0);
    setOffset({ x: 0, y: 0 });
  };

  return (
    <div className="file-inline-image-preview">
      <div
        className="file-inline-image-viewport"
        data-dragging={dragging || undefined}
        onWheel={(event) => {
          event.preventDefault();
          const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
          const nextScale = scale * Math.exp(-delta * 0.002);
          zoomAt(nextScale, event.clientX, event.clientY, event.currentTarget);
        }}
        onPointerDown={(event) => {
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          setDragging(true);
          dragRef.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            originX: offset.x,
            originY: offset.y,
          };
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          setOffset({
            x: drag.originX + event.clientX - drag.startX,
            y: drag.originY + event.clientY - drag.startY,
          });
        }}
        onPointerUp={(event) => {
          if (dragRef.current?.pointerId !== event.pointerId) return;
          event.currentTarget.releasePointerCapture(event.pointerId);
          dragRef.current = null;
          setDragging(false);
        }}
        onLostPointerCapture={() => {
          dragRef.current = null;
          setDragging(false);
        }}
      >
        <img
          className="file-preview-image"
          src={src}
          alt={alt}
          draggable={false}
          style={{
            transform: `translate3d(${offset.x}px, ${offset.y}px, 0) rotate(${rotation}deg) scale(${scale})`,
          }}
        />
      </div>
      <div className="file-inline-image-toolbar" aria-label="图片预览工具栏">
        <TooltipIconButton
          tooltip="缩小"
          aria-label="缩小"
          disabled={scale <= MIN_SCALE}
          onClick={() => changeScale(-0.25)}
        >
          <ZoomOut aria-hidden="true" />
        </TooltipIconButton>
        <span aria-live="polite">{Math.round(scale * 100)}%</span>
        <TooltipIconButton
          tooltip="放大"
          aria-label="放大"
          disabled={scale >= MAX_SCALE}
          onClick={() => changeScale(0.25)}
        >
          <ZoomIn aria-hidden="true" />
        </TooltipIconButton>
        <span className="file-inline-image-divider" aria-hidden="true" />
        <TooltipIconButton tooltip="向左旋转" aria-label="向左旋转" onClick={() => setRotation((value) => value - 90)}>
          <RotateCcw aria-hidden="true" />
        </TooltipIconButton>
        <TooltipIconButton tooltip="向右旋转" aria-label="向右旋转" onClick={() => setRotation((value) => value + 90)}>
          <RotateCw aria-hidden="true" />
        </TooltipIconButton>
        <TooltipIconButton tooltip="重置视图" aria-label="重置视图" disabled={!transformed} onClick={reset}>
          <Scan aria-hidden="true" />
        </TooltipIconButton>
      </div>
    </div>
  );
}
