import type { SessionControlState } from "../../../../shared/contracts.ts";
import { getThinkingLevelLabel } from "../../shared/lib/thinking-level-label.ts";
import { Select } from "../assistant-ui/select/select.tsx";

interface ThinkingSelectProps {
  value: SessionControlState["thinkingLevel"];
  levels: SessionControlState["thinkingLevels"];
  disabled?: boolean;
  onValueChange(value: SessionControlState["thinkingLevel"]): void;
}

/** draft 与 committed session 共用的受控 thinking level 选择器。 */
export function ThinkingSelect({ value, levels, disabled = false, onValueChange }: ThinkingSelectProps) {
  return (
    <Select
      value={value}
      className="max-w-24 text-sm ps-2 pe-2"
      tooltip="选择思考等级"
      options={levels.map((level) => ({ value: level, label: getThinkingLevelLabel(level) }))}
      disabled={disabled || levels.length === 0}
      onValueChange={(nextValue) => {
        const nextLevel = nextValue as SessionControlState["thinkingLevel"];
        if (nextLevel !== value) onValueChange(nextLevel);
      }}
    />
  );
}
