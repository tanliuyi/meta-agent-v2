import * as RadioGroup from "@radix-ui/react-radio-group";
import { useTheme } from "@renderer/state/theme";
import { parseThemePreference, type ThemePreference } from "@renderer/state/theme-preference";
import Laptop from "lucide-react/dist/esm/icons/laptop.mjs";
import Moon from "lucide-react/dist/esm/icons/moon.mjs";
import Sun from "lucide-react/dist/esm/icons/sun.mjs";
import type { ComponentType } from "react";

const THEME_OPTIONS: Array<{ value: ThemePreference; label: string; icon: ComponentType<{ size?: number }> }> = [
  { value: "system", label: "系统", icon: Laptop },
  { value: "light", label: "浅色", icon: Sun },
  { value: "dark", label: "深色", icon: Moon },
];

/** 在系统、浅色和深色主题之间切换持久化偏好。 */
export function ThemePreferenceControl() {
  const { preference, setPreference } = useTheme();

  return (
    <RadioGroup.Root
      className="settings-segmented-control"
      aria-label="主题"
      orientation="horizontal"
      value={preference}
      onValueChange={(value) => setPreference(parseThemePreference(value))}
    >
      {THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
        <RadioGroup.Item key={value} value={value} className="settings-segmented-item">
          <Icon aria-hidden="true" />
          {label}
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  );
}
