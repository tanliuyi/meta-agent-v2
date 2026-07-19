import { ComposerPrimitive, useAuiState } from "@assistant-ui/react";
import { AttachmentUI } from "./attachment-ui.tsx";

export function ComposerAttachments({ disabled }: { disabled?: boolean }) {
  const hasAttachments = useAuiState((state) => state.composer.attachments.length > 0);
  if (!hasAttachments) return null;

  return (
    <div className="aui-composer-attachments flex w-full flex-row items-center gap-2 overflow-x-auto">
      <ComposerPrimitive.Attachments>{() => <AttachmentUI disabled={disabled} />}</ComposerPrimitive.Attachments>
    </div>
  );
}
