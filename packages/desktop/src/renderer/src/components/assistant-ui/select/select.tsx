import * as SelectPrimitive from "@radix-ui/react-select";
import { cn } from "@renderer/shared/lib/cn";
import { Tooltip } from "@renderer/shared/ui/tooltip";
import { TooltipContent } from "@renderer/shared/ui/tooltip-content";
import { TooltipTrigger } from "@renderer/shared/ui/tooltip-trigger";
import ChevronDownIcon from "lucide-react/dist/esm/icons/chevron-down.mjs";
import { useState } from "react";
import { SelectContent } from "./select-content.tsx";
import { SelectItem } from "./select-item.tsx";
import { SelectRoot } from "./select-root.tsx";
import type { SelectProps } from "./select-types.ts";

export function Select({
  options,
  placeholder,
  tooltip,
  className,
  id,
  "aria-labelledby": ariaLabelledby,
  "aria-describedby": ariaDescribedby,
  "aria-invalid": ariaInvalid,
  ...props
}: SelectProps) {
  const [selectOpen, setSelectOpen] = useState(false);
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const selectedOption = options.find((option) => option.value === props.value);
  const trigger = (
    <SelectPrimitive.Trigger
      id={id}
      aria-labelledby={ariaLabelledby}
      aria-describedby={ariaDescribedby}
      aria-invalid={ariaInvalid}
      className={cn(
        "group flex items-center gap-1 rounded-xl py-1 px-2 text-sm transition-colors outline-none",
        "text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring/50 focus-visible:ring-2",
        "disabled:cursor-not-allowed disabled:opacity-50",
        !selectedOption && placeholder ? "italic opacity-70" : null,
        className,
      )}
    >
      <span className="min-w-0 truncate">{selectedOption?.label ?? placeholder}</span>
      <SelectPrimitive.Icon asChild>
        <ChevronDownIcon className="size-4 opacity-50 transition-transform group-data-[state=open]:rotate-180" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );

  return (
    <SelectRoot
      {...props}
      open={selectOpen}
      onOpenChange={(open) => {
        setSelectOpen(open);
        if (open) setTooltipOpen(false);
      }}
    >
      {tooltip ? (
        <Tooltip
          open={tooltipOpen && !selectOpen}
          delayDuration={1000}
          onOpenChange={(open) => {
            setTooltipOpen(selectOpen ? false : open);
          }}
        >
          <TooltipTrigger asChild>{trigger}</TooltipTrigger>
          <TooltipContent side="top">{tooltip}</TooltipContent>
        </Tooltip>
      ) : (
        trigger
      )}

      <SelectContent>
        {options.map(({ label, disabled, textValue, description, ...itemProps }) => (
          <SelectItem
            key={itemProps.value}
            {...itemProps}
            {...(description !== undefined ? { description } : {})}
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
