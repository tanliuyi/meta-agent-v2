import { MessagePrimitive } from "@assistant-ui/react";
import { AttachmentUI } from "./attachment-ui.tsx";

export function UserMessageAttachments() {
  return (
    <div className="aui-user-message-attachments-end col-span-full col-start-1 row-start-1 flex w-full flex-row justify-end gap-2">
      <MessagePrimitive.Attachments>{() => <AttachmentUI />}</MessagePrimitive.Attachments>
    </div>
  );
}
