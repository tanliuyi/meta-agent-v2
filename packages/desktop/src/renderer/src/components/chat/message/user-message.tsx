import { MessagePrimitive, useAuiState } from "@assistant-ui/react";
import { UserMessageAttachments } from "../../assistant-ui/attachment/user-message-attachments.tsx";
import { EditComposer } from "./edit-composer.tsx";
import { UserMessageActionBar } from "./user-message-action-bar.tsx";
import { UserMessageContent } from "./user-message-content.tsx";

export function UserMessage() {
  const isEditing = useAuiState((state) => state.message.composer.isEditing);
  if (isEditing) return <EditComposer />;

  return (
    <MessagePrimitive.Root
      data-slot="aui_user-message-root"
      data-role="user"
      className="fade-in slide-in-from-bottom-1 animate-in grid auto-rows-auto grid-cols-[minmax(72px,1fr)_auto] content-start gap-y-2 px-2 duration-150 [contain-intrinsic-size:auto_200px] [content-visibility:auto] [&:where(>*)]:col-start-2"
    >
      <UserMessageAttachments />

      <div className="aui-user-message-content-wrapper relative col-start-2 min-w-0">
        <UserMessageContent />
      </div>

      <div className="aui-user-message-footer col-span-full col-start-1 row-start-3 flex min-h-7 items-center justify-end">
        <UserMessageActionBar />
      </div>
    </MessagePrimitive.Root>
  );
}
