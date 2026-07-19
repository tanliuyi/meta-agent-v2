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
      className="grid min-w-0 max-w-72 flex-1 grid-cols-3 gap-1 rounded-md bg-muted p-1"
      aria-label="主题"
      orientation="horizontal"
      value={preference}
      onValueChange={(value) => setPreference(parseThemePreference(value))}
    >
      {THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
        <RadioGroup.Item
          key={value}
          value={value}
          className="flex h-9 items-center justify-center gap-1.5 rounded-sm px-2 text-xs text-muted-foreground transition-colors hover:text-foreground data-[state=checked]:bg-background data-[state=checked]:text-foreground data-[state=checked]:shadow-sm"
        >
          <Icon size={14} />
          {label}
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  );
}
