import { AttachmentPrimitive, useAui, useAuiState } from "@assistant-ui/react";
import { cn } from "@renderer/shared/lib/cn";
import { Tooltip } from "@renderer/shared/ui/tooltip";
import { TooltipContent } from "@renderer/shared/ui/tooltip-content";
import { TooltipTrigger } from "@renderer/shared/ui/tooltip-trigger";
import AlertCircleIcon from "lucide-react/dist/esm/icons/circle-alert.mjs";
import Loader2Icon from "lucide-react/dist/esm/icons/loader-circle.mjs";
import { AttachmentPreviewDialog } from "./attachment-preview-dialog.tsx";
import { AttachmentRemove } from "./attachment-remove.tsx";
import { AttachmentThumb } from "./attachment-thumb.tsx";

/** 绑定当前 assistant-ui attachment scope，并以原生 button 组合预览与 tooltip 触发行为。 */
export function AttachmentUI({ disabled }: { disabled?: boolean }) {
  const aui = useAui();
  const isComposer = aui.attachment.source !== "message";
  const isImage = useAuiState((state) => state.attachment.type === "image");
  const typeLabel = useAuiState((state) => {
    switch (state.attachment.type) {
      case "image":
        return "Image";
      case "document":
        return "Document";
      case "file":
        return "File";
      default:
        return state.attachment.type;
    }
  });
  const uploadState = useAuiState((state) =>
    state.attachment.status.type === "running"
      ? "uploading"
      : state.attachment.status.type === "incomplete" && state.attachment.status.reason === "error"
        ? "error"
        : undefined,
  );
  const isUploading = uploadState === "uploading";
  const isError = uploadState === "error";
  const errorMessage = useAuiState((state) =>
    state.attachment.status.type === "incomplete" && state.attachment.status.reason === "error"
      ? "上传失败"
      : undefined,
  );

  return (
    <Tooltip>
      <AttachmentPrimitive.Root
        className={cn(
          "aui-attachment-root relative",
          isImage && !isComposer && "aui-attachment-root-message only:*:first:size-24",
        )}
      >
        <AttachmentPreviewDialog>
          <TooltipTrigger asChild>
            <button
              type="button"
              className={cn(
                "aui-attachment-tile bg-muted relative size-14 cursor-pointer overflow-hidden rounded-[calc(var(--composer-radius)-var(--composer-padding))] border transition-opacity hover:opacity-75",
                isError && "border-destructive",
              )}
              aria-label={`${typeLabel} attachment${isError ? ", upload failed" : isUploading ? ", uploading" : ""}`}
            >
              <AttachmentThumb />
              {isUploading ? (
                <div
                  aria-hidden="true"
                  className="aui-attachment-tile-uploading bg-background/60 absolute inset-0 flex items-center justify-center backdrop-blur-[1px]"
                >
                  <Loader2Icon className="text-muted-foreground size-5 animate-spin" />
                </div>
              ) : null}
              {isError ? (
                <div
                  aria-hidden="true"
                  className="aui-attachment-tile-error bg-destructive/10 absolute inset-0 flex items-center justify-center"
                >
                  <AlertCircleIcon className="text-destructive size-5" />
                </div>
              ) : null}
            </button>
          </TooltipTrigger>
        </AttachmentPreviewDialog>
        {isComposer ? <AttachmentRemove disabled={disabled} /> : null}
      </AttachmentPrimitive.Root>
      <TooltipContent side="top">
        <AttachmentPrimitive.Name />
        {errorMessage ? <p className="aui-attachment-error-message">{errorMessage}</p> : null}
      </TooltipContent>
    </Tooltip>
  );
}
