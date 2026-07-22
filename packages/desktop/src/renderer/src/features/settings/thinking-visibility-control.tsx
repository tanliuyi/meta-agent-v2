import { Switch } from "@renderer/shared/ui/switch";
import { useThinkingVisibility } from "@renderer/state/thinking-visibility";

export const THINKING_VISIBILITY_LABEL_ID = "thinking-visibility-label";

/** 控制 assistant 消息中的 thinking 内容是否可见。 */
export function ThinkingVisibilityControl() {
  const { showThinking, canUpdateThinkingVisibility, setShowThinking } = useThinkingVisibility();

  return (
    <Switch
      aria-labelledby={THINKING_VISIBILITY_LABEL_ID}
      checked={showThinking}
      disabled={!canUpdateThinkingVisibility}
      onCheckedChange={(checked) => void setShowThinking(checked)}
    />
  );
}
