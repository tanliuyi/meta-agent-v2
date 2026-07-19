import { Dialog } from "@renderer/shared/ui/dialog";
import { DialogContent } from "@renderer/shared/ui/dialog-content";
import { DialogTitle } from "@renderer/shared/ui/dialog-title";
import { DialogTrigger } from "@renderer/shared/ui/dialog-trigger";
import type { PropsWithChildren } from "react";
import { AttachmentPreview } from "./attachment-preview.tsx";
import { useAttachmentSrc } from "./use-attachment-src.ts";

/** 将附件 tile 作为 DialogTrigger；调用方必须提供可聚焦的原生交互元素。 */
export function AttachmentPreviewDialog({ children }: PropsWithChildren) {
  const src = useAttachmentSrc();
  if (!src) return children;

  return (
    <Dialog>
      <DialogTrigger
        className="aui-attachment-preview-trigger hover:bg-accent/50 cursor-pointer transition-colors"
        asChild
      >
        {children}
      </DialogTrigger>
      <DialogContent
        className="aui-attachment-preview-dialog-content p-2 sm:max-w-3xl"
        closeButtonClassName="rounded-full bg-foreground/60 p-1 text-background opacity-100 hover:text-destructive"
      >
        <DialogTitle className="aui-sr-only sr-only">Image Attachment Preview</DialogTitle>
        <div className="aui-attachment-preview bg-background relative mx-auto flex max-h-[80dvh] w-full items-center justify-center overflow-hidden">
          <AttachmentPreview src={src} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
