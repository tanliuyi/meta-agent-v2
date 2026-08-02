import { isValidElement, type PropsWithChildren } from "react";
import { AttachmentPreview } from "./attachment-preview.tsx";
import { useAttachmentSrc } from "./use-attachment-src.ts";

/** 将附件 tile 作为 react-photo-view 的 hero 动画原点。 */
export function AttachmentPreviewDialog({ children }: PropsWithChildren) {
  const src = useAttachmentSrc();
  if (!src || !isValidElement(children)) return children;

  return <AttachmentPreview src={src}>{children}</AttachmentPreview>;
}
