import { userAvatarInitial } from "@renderer/shared/lib/user-avatar-initial";
import { useThinkingVisibility } from "@renderer/state/thinking-visibility";
import { useState } from "react";
import { userAvatarPathToUrl } from "../../../../../shared/settings-config-contracts.ts";

/** 用户消息头像：自定义图片不可用时回退到用户名首字符。 */
export function UserMessageAvatar() {
  const { userAvatarPath, userName } = useThinkingVisibility();
  const avatarUrl = userAvatarPath ? userAvatarPathToUrl(userAvatarPath) : null;
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const showImage = avatarUrl && failedUrl !== avatarUrl;

  return (
    <span className={showImage ? "message-avatar" : "message-avatar message-avatar-user-default"} aria-hidden="true">
      {showImage ? <img src={avatarUrl} alt="" onError={() => setFailedUrl(avatarUrl)} /> : userAvatarInitial(userName)}
    </span>
  );
}
