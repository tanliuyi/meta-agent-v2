import { Switch } from "@renderer/shared/ui/switch";
import { useThinkingVisibility } from "@renderer/state/thinking-visibility";

export const RUNNING_AUTO_EXPAND_LABEL_ID = "running-auto-expand-label";

/** 控制消息生成期间的处理过程是否自动展开。 */
export function RunningAutoExpandControl() {
  const { autoExpandRunning, canUpdateMessageSettings, setAutoExpandRunning } = useThinkingVisibility();

  return (
    <Switch
      aria-labelledby={RUNNING_AUTO_EXPAND_LABEL_ID}
      checked={autoExpandRunning}
      disabled={!canUpdateMessageSettings}
      onCheckedChange={(checked) => void setAutoExpandRunning(checked)}
    />
  );
}
