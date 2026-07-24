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
        className="aui-attachment-preview-dialog-content left-0 top-0 block h-dvh w-screen max-w-none translate-x-0 translate-y-0 overflow-hidden border-0 bg-transparent p-0 shadow-none sm:rounded-none"
        closeButtonClassName="fixed right-4 top-4 z-20 rounded-full bg-background/80 p-2 text-foreground opacity-100 shadow-(--elevation-popover) backdrop-blur-sm hover:text-destructive"
      >
        <DialogTitle className="aui-sr-only sr-only">Image Attachment Preview</DialogTitle>
        <AttachmentPreview src={src} />
      </DialogContent>
    </Dialog>
  );
}
