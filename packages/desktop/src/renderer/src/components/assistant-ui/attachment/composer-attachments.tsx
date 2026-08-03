import { ComposerPrimitive, useAuiState } from "@assistant-ui/react";
import { AttachmentUI } from "./attachment-ui.tsx";

export function ComposerAttachments({ disabled }: { disabled?: boolean }) {
  const hasAttachments = useAuiState((state) => state.composer.attachments.length > 0);
  if (!hasAttachments) return null;

  return (
    <div className="aui-composer-attachments flex w-full flex-row flex-wrap items-center gap-2 px-1 pt-1">
      <ComposerPrimitive.Attachments>{() => <AttachmentUI disabled={disabled} />}</ComposerPrimitive.Attachments>
    </div>
  );
}
