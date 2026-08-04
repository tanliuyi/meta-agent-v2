import * as RadioGroup from "@radix-ui/react-radio-group";
import { ColorPicker } from "@renderer/shared/ui/color-picker";
import { useTheme } from "@renderer/state/theme";
import { parseThemeColorPreference, THEME_COLOR_PRESETS, themeColorHex } from "@renderer/state/theme-color-preference";
import Check from "lucide-react/dist/esm/icons/check.mjs";
import Palette from "lucide-react/dist/esm/icons/palette.mjs";
import type { CSSProperties } from "react";

export const THEME_COLOR_LABEL_ID = "theme-color-label";

type SwatchStyle = CSSProperties & { "--theme-color-swatch": string };

/** 选择预设主题色，或用颜色选择器与十六进制输入配置自定义色。 */
export function ThemeColorControl() {
  const { resolvedTheme, colorPreference, customColor, setColorPreference, setCustomColor } = useTheme();

  const options = [
    ...THEME_COLOR_PRESETS.map((preset) => ({
      value: preset.id,
      label: preset.label,
      color: preset[resolvedTheme],
    })),
    {
      value: "custom" as const,
      label: "自定",
      color: themeColorHex("custom", customColor, resolvedTheme),
    },
  ];

  return (
    <div className="theme-color-control">
      <RadioGroup.Root
        className="theme-color-presets"
        aria-labelledby={THEME_COLOR_LABEL_ID}
        value={colorPreference}
        onValueChange={(value) => setColorPreference(parseThemeColorPreference(value))}
      >
        {options.map(({ value, label, color }) => (
          <RadioGroup.Item
            key={value}
            value={value}
            className="theme-color-option"
            aria-label={label}
            title={label}
            style={{ "--theme-color-swatch": color } as SwatchStyle}
          >
            <span className="theme-color-swatch" aria-hidden="true">
              {value === "custom" ? <Palette className="theme-color-custom-icon" /> : null}
              <Check className="theme-color-check" />
            </span>
            <span className="theme-color-option-label">{label}</span>
          </RadioGroup.Item>
        ))}
      </RadioGroup.Root>

      {colorPreference === "custom" ? (
        <div className="theme-color-custom-panel">
          <ColorPicker
            aria-label="自定义主题色"
            value={customColor}
            onValueChange={setCustomColor}
            className="theme-color-picker-trigger"
          />
        </div>
      ) : null}
    </div>
  );
}
