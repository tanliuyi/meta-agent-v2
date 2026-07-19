import * as SelectPrimitive from "@radix-ui/react-select";
import { cn } from "@renderer/shared/lib/cn";
import { SelectContent } from "./select-content.tsx";
import { SelectItem } from "./select-item.tsx";
import { SelectRoot } from "./select-root.tsx";
import type { SelectProps } from "./select-types.ts";

export function Select({ options, placeholder, className, ...props }: SelectProps) {
  const selectedOption = options.find((option) => option.value === props.value);

  return (
    <SelectRoot {...props}>
      <SelectPrimitive.Trigger
        className={cn(
          "flex items-center gap-1.5 rounded-md py-1 ps-3 pe-2 text-sm transition-colors outline-none",
          "text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring/50 focus-visible:ring-2",
          "disabled:cursor-not-allowed disabled:opacity-50",
          !selectedOption && placeholder ? "italic opacity-70" : null,
          className,
        )}
      >
        <span>{selectedOption?.label ?? placeholder}</span>
      </SelectPrimitive.Trigger>

      <SelectContent>
        {options.map(({ label, disabled, textValue, ...itemProps }) => (
          <SelectItem
            key={itemProps.value}
            {...itemProps}
            {...(disabled !== undefined ? { disabled } : {})}
            textValue={textValue ?? (typeof label === "string" ? label : itemProps.value)}
          >
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </SelectRoot>
  );
}
