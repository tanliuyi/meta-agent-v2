import { MessagePrimitive, useAuiState } from "@assistant-ui/react";
import { cn } from "@renderer/shared/lib/cn";
import { useThinkingVisibility } from "@renderer/state/thinking-visibility";
import { UserMessageAttachments } from "../../assistant-ui/attachment/user-message-attachments.tsx";
import { EditComposer } from "./edit-composer.tsx";
import { UserMessageActionBar } from "./user-message-action-bar.tsx";
import { UserMessageAvatar } from "./user-message-avatar.tsx";
import { UserMessageContent } from "./user-message-content.tsx";

export function UserMessage() {
  const isEditing = useAuiState((state) => state.message.composer.isEditing);
  const hasAttachments = useAuiState((state) => (state.message.attachments?.length ?? 0) > 0);
  const isThreadFirstMessage = useAuiState((state) => state.thread.messages[0]?.id === state.message.id);
  const { showAvatars, userName } = useThinkingVisibility();
  if (isEditing) return <EditComposer />;

  return (
    <MessagePrimitive.Root
      data-slot="aui_user-message-root"
      data-role="user"
      className={cn(
        showAvatars && "contents",
        !showAvatars &&
          "fade-in slide-in-from-bottom-1 animate-in mt-4 flex flex-col gap-y-2 duration-150 [contain-intrinsic-size:auto_200px] [content-visibility:auto]",
      )}
    >
      {showAvatars ? (
        <div
          data-slot="message-avatar-header"
          className={cn(
            "fade-in slide-in-from-bottom-1 animate-in flex min-w-0 items-center gap-2 duration-150",
            isThreadFirstMessage ? "mt-3" : "mt-8",
          )}
        >
          <UserMessageAvatar />
          <div className="message-avatar-name message-avatar-name-user">{userName}</div>
        </div>
      ) : null}
      {hasAttachments ? <UserMessageAttachments align={showAvatars ? "start" : "end"} /> : null}

      <div
        className={cn(
          "aui-user-message-content-wrapper min-w-0",
          showAvatars
            ? "aui-user-message-sticky sticky top-0 z-(--stack-sticky-control) mt-1 w-full"
            : "relative w-fit max-w-[85%] self-end",
        )}
      >
        <UserMessageContent />
      </div>

      <div
        className={cn(
          "aui-user-message-footer flex w-full items-center",
          showAvatars ? "min-h-7" : "min-h-7 justify-end",
        )}
      >
        <UserMessageActionBar autohide={"always"} />
      </div>
    </MessagePrimitive.Root>
  );
}
