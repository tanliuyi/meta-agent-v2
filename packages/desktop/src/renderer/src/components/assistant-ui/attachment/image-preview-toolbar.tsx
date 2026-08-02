import Image from "@rc-component/image";
import { TooltipIconButton } from "@renderer/components/assistant-ui/tooltip-icon-button";
import RotateCcw from "lucide-react/dist/esm/icons/rotate-ccw.mjs";
import RotateCw from "lucide-react/dist/esm/icons/rotate-cw.mjs";
import Scan from "lucide-react/dist/esm/icons/scan.mjs";
import X from "lucide-react/dist/esm/icons/x.mjs";
import ZoomIn from "lucide-react/dist/esm/icons/zoom-in.mjs";
import ZoomOut from "lucide-react/dist/esm/icons/zoom-out.mjs";
import type { ComponentProps, ReactElement } from "react";

export const MIN_IMAGE_PREVIEW_SCALE = 0.25;
export const MAX_IMAGE_PREVIEW_SCALE = 10;

type ImageProps = ComponentProps<typeof Image>;
type ImagePreviewConfig = Exclude<ImageProps["preview"], boolean | undefined>;
type ImagePreviewActionsRender = NonNullable<ImagePreviewConfig["actionsRender"]>;
type ImagePreviewToolbarProps = Parameters<ImagePreviewActionsRender>[1];

export function ImagePreviewToolbar({ actions, transform }: ImagePreviewToolbarProps) {
  const { rotate, scale } = transform;
  const transformed = scale !== 1 || rotate % 360 !== 0 || transform.flipX || transform.flipY;

  return (
    <div className="aui-image-preview-toolbar">
      <TooltipIconButton
        className="aui-image-preview-action"
        tooltip="缩小"
        side="top"
        disabled={scale <= MIN_IMAGE_PREVIEW_SCALE}
        onClick={actions.onZoomOut}
      >
        <ZoomOut aria-hidden="true" />
      </TooltipIconButton>
      <span className="aui-image-preview-scale">{Math.round(scale * 100)}%</span>
      <TooltipIconButton
        className="aui-image-preview-action"
        tooltip="放大"
        side="top"
        disabled={scale >= MAX_IMAGE_PREVIEW_SCALE}
        onClick={actions.onZoomIn}
      >
        <ZoomIn aria-hidden="true" />
      </TooltipIconButton>
      <span className="aui-image-preview-divider" aria-hidden="true" />
      <TooltipIconButton
        className="aui-image-preview-action"
        tooltip="向左旋转"
        side="top"
        onClick={actions.onRotateLeft}
      >
        <RotateCcw aria-hidden="true" />
      </TooltipIconButton>
      <TooltipIconButton
        className="aui-image-preview-action"
        tooltip="向右旋转"
        side="top"
        onClick={actions.onRotateRight}
      >
        <RotateCw aria-hidden="true" />
      </TooltipIconButton>
      <TooltipIconButton
        className="aui-image-preview-action"
        tooltip="重置视图"
        side="top"
        disabled={!transformed}
        onClick={actions.onReset}
      >
        <Scan aria-hidden="true" />
      </TooltipIconButton>
      <span className="aui-image-preview-divider" aria-hidden="true" />
      <TooltipIconButton className="aui-image-preview-action" tooltip="关闭预览" side="top" onClick={actions.onClose}>
        <X aria-hidden="true" />
      </TooltipIconButton>
    </div>
  );
}

export function renderImagePreviewToolbar(_originalNode: ReactElement, props: ImagePreviewToolbarProps) {
  return <ImagePreviewToolbar {...props} />;
}
