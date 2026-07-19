import type { SessionControlState } from "../../../../shared/contracts.ts";
import { Select } from "../assistant-ui/select/select.tsx";
import { getThinkingLevelLabel } from "./composer-control-model.ts";

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
      options={levels.map((level) => ({ value: level, label: getThinkingLevelLabel(level) }))}
      disabled={disabled || levels.length === 0}
      onValueChange={(nextValue) => onValueChange(nextValue as SessionControlState["thinkingLevel"])}
    />
  );
}
