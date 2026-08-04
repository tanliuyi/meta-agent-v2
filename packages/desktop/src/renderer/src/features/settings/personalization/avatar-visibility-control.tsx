import { Switch } from "@renderer/shared/ui/switch";
import { useThinkingVisibility } from "@renderer/state/thinking-visibility";

export const AVATAR_VISIBILITY_LABEL_ID = "avatar-visibility-label";

/** 控制对话消息旁的模型提供方头像是否可见。 */
export function AvatarVisibilityControl() {
  const { showAvatars, canUpdateMessageSettings, setShowAvatars } = useThinkingVisibility();

  return (
    <Switch
      aria-labelledby={AVATAR_VISIBILITY_LABEL_ID}
      checked={showAvatars}
      disabled={!canUpdateMessageSettings}
      onCheckedChange={(checked) => void setShowAvatars(checked)}
    />
  );
}
