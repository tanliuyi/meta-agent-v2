import { MessagePrimitive } from "@assistant-ui/react";
import { cn } from "@renderer/shared/lib/cn";
import { AttachmentUI } from "./attachment-ui.tsx";

interface UserMessageAttachmentsProps {
  align?: "start" | "end";
}

export function UserMessageAttachments({ align = "end" }: UserMessageAttachmentsProps) {
  return (
    <div
      className={cn(
        "aui-user-message-attachments flex w-full flex-row gap-2",
        align === "start" ? "mt-2 flex-wrap justify-start" : "justify-end",
      )}
    >
      <MessagePrimitive.Attachments>{() => <AttachmentUI />}</MessagePrimitive.Attachments>
    </div>
  );
}
