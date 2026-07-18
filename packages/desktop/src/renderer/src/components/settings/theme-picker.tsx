import { Laptop, Moon, Settings, Sun } from "lucide-react";
import type { ComponentType } from "react";
import { type ThemePreference, useTheme } from "../../state/theme.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover.tsx";

const THEME_OPTIONS: Array<{ value: ThemePreference; label: string; icon: ComponentType<{ size?: number }> }> = [
  { value: "system", label: "系统", icon: Laptop },
  { value: "light", label: "浅色", icon: Sun },
  { value: "dark", label: "深色", icon: Moon },
];

export function ThemePicker() {
  const { preference, setPreference } = useTheme();

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" aria-label="外观设置">
          <Settings size={15} />
          设置
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" sideOffset={8} className="w-64 p-3">
        <div className="mb-2 px-1 text-xs font-medium text-muted-foreground">外观</div>
        <div className="grid grid-cols-3 gap-1 rounded-md bg-muted p-1" role="radiogroup" aria-label="主题">
          {THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={preference === value}
              data-active={preference === value || undefined}
              className="flex h-8 items-center justify-center gap-1.5 rounded-sm px-2 text-xs text-muted-foreground transition-colors hover:text-foreground data-active:bg-background data-active:text-foreground data-active:shadow-sm"
              onClick={() => setPreference(value)}
            >
              <Icon size={14} />
              {label}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
