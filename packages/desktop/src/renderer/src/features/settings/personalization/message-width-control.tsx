import * as RadioGroup from "@radix-ui/react-radio-group";
import { useThinkingVisibility } from "@renderer/state/thinking-visibility";
import { MESSAGE_WIDTH_DEFAULT } from "../../../../../shared/settings-config-contracts.ts";

export const MESSAGE_WIDTH_LABEL_ID = "message-width-label";

const MESSAGE_WIDTH_PRESETS: Array<{ key: string; label: string; value: number | null }> = [
  { key: "small", label: "小", value: 640 },
  { key: "medium", label: "中", value: MESSAGE_WIDTH_DEFAULT },
  { key: "large", label: "大", value: 980 },
  { key: "full", label: "满屏", value: null },
];

/** 消息宽度：小 / 中 / 大预设与满屏，选择后即时生效并防抖持久化。 */
export function MessageWidthControl() {
  const { messageWidth, canUpdateMessageSettings, setMessageWidth } = useThinkingVisibility();
  const selectedKey = MESSAGE_WIDTH_PRESETS.find((option) => option.value === messageWidth)?.key;

  return (
    <RadioGroup.Root
      className="settings-segmented-control"
      aria-label="消息宽度"
      orientation="horizontal"
      value={selectedKey ?? ""}
      onValueChange={(value) => {
        const option = MESSAGE_WIDTH_PRESETS.find((candidate) => candidate.key === value);
        if (option) setMessageWidth(option.value);
      }}
    >
      {MESSAGE_WIDTH_PRESETS.map((option) => (
        <RadioGroup.Item
          key={option.key}
          value={option.key}
          className="settings-segmented-item"
          disabled={!canUpdateMessageSettings}
        >
          {option.label}
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  );
}
