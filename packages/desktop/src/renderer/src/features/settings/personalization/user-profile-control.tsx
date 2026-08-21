import { userAvatarInitial } from "@renderer/shared/lib/user-avatar-initial";
import { Button } from "@renderer/shared/ui/button";
import { Input } from "@renderer/shared/ui/input";
import { useThinkingVisibility } from "@renderer/state/thinking-visibility";
import ImagePlus from "lucide-react/dist/esm/icons/image-plus.mjs";
import Save from "lucide-react/dist/esm/icons/save.mjs";
import Trash2 from "lucide-react/dist/esm/icons/trash-2.mjs";
import { useEffect, useState } from "react";
import { USER_NAME_MAX_LENGTH, userAvatarPathToUrl } from "../../../../../shared/settings-config-contracts.ts";

type ProfileStatus = "idle" | "saving" | "saved" | "error";

const USER_NAME_LABEL_ID = "user-name-label";

export function UserProfileControl() {
  const { userName, userAvatarPath, canUpdateMessageSettings, setUserProfile } = useThinkingVisibility();
  const [draftName, setDraftName] = useState(userName);
  const [status, setStatus] = useState<ProfileStatus>("idle");
  const avatarUrl = userAvatarPath ? userAvatarPathToUrl(userAvatarPath) : null;
  const [failedAvatarUrl, setFailedAvatarUrl] = useState<string | null>(null);
  const showAvatarImage = avatarUrl !== null && failedAvatarUrl !== avatarUrl;

  useEffect(() => setDraftName(userName), [userName]);
  useEffect(() => setFailedAvatarUrl(null), [avatarUrl]);

  const normalizedName = draftName.trim();
  const validName = normalizedName.length > 0 && normalizedName.length <= USER_NAME_MAX_LENGTH;
  const busy = status === "saving";

  const saveProfile = async (avatarPath = userAvatarPath): Promise<boolean> => {
    if (!validName) {
      setStatus("error");
      return false;
    }
    setStatus("saving");
    const saved = await setUserProfile(normalizedName, avatarPath);
    setStatus(saved ? "saved" : "error");
    return saved;
  };

  const chooseAvatar = async () => {
    const path = await window.desktop.settings.chooseUserAvatar();
    if (path) await saveProfile(path);
  };

  return (
    <>
      <div className="settings-row">
        <div className="settings-row-text">
          <span>头像</span>
          <p className="settings-row-description">显示在你的对话消息旁</p>
        </div>
        <div className="user-profile-avatar-control">
          <div className={showAvatarImage ? "user-profile-avatar" : "user-profile-avatar user-profile-avatar-default"}>
            {showAvatarImage ? (
              <img src={avatarUrl} alt="" onError={() => setFailedAvatarUrl(avatarUrl)} />
            ) : (
              <span className="user-profile-avatar-initial" aria-hidden="true">
                {userAvatarInitial(draftName)}
              </span>
            )}
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={!canUpdateMessageSettings || busy}
            onClick={() => void chooseAvatar()}
          >
            <ImagePlus />
            选择图片
          </Button>
          {userAvatarPath ? (
            <Button
              variant="ghost"
              size="icon"
              aria-label="移除头像"
              title="移除头像"
              disabled={!canUpdateMessageSettings || busy}
              onClick={() => void saveProfile(null)}
            >
              <Trash2 />
            </Button>
          ) : null}
        </div>
      </div>
      <div className="settings-row">
        <div className="settings-row-text">
          <span id={USER_NAME_LABEL_ID}>用户名</span>
          <p className="settings-row-description">用于标识你在对话中的身份</p>
        </div>
        <div className="user-profile-name-control">
          <Input
            aria-labelledby={USER_NAME_LABEL_ID}
            value={draftName}
            maxLength={USER_NAME_MAX_LENGTH}
            disabled={!canUpdateMessageSettings || busy}
            onChange={(event) => {
              setDraftName(event.target.value);
              setStatus("idle");
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") void saveProfile();
              else if (event.key === "Escape") setDraftName(userName);
            }}
          />
          <Button
            variant="outline"
            size="icon"
            aria-label="保存用户名"
            title="保存用户名"
            disabled={!canUpdateMessageSettings || !validName || busy}
            onClick={() => void saveProfile()}
          >
            <Save />
          </Button>
        </div>
      </div>
      <p className="user-profile-status" aria-live="polite" data-status={status}>
        {statusText(status)}
      </p>
    </>
  );
}

function statusText(status: ProfileStatus): string {
  if (status === "saving") return "正在保存";
  if (status === "saved") return "已保存";
  if (status === "error") return "操作失败，请检查用户名或稍后重试";
  return "";
}
