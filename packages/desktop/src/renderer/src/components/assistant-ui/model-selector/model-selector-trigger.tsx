import { cn } from "@renderer/shared/lib/cn";
import { PopoverTrigger } from "@renderer/shared/ui/popover-trigger";
import type { VariantProps } from "class-variance-authority";
import type { ComponentPropsWithoutRef } from "react";
import { useModelSelectorContext } from "./model-selector-context.ts";
import { ModelSelectorValue } from "./model-selector-value.tsx";
import { modelSelectorTriggerVariants } from "./model-selector-variants.ts";

export type ModelSelectorTriggerProps = ComponentPropsWithoutRef<typeof PopoverTrigger> &
  VariantProps<typeof modelSelectorTriggerVariants>;

export function ModelSelectorTrigger({
  className,
  variant,
  size,
  children,
  onKeyDown,
  ...props
}: ModelSelectorTriggerProps) {
  const { setOpen } = useModelSelectorContext();
  return (
    <PopoverTrigger
      data-slot="model-selector-trigger"
      data-variant={variant ?? "outline"}
      data-size={size ?? "default"}
      role="combobox"
      aria-haspopup="listbox"
      className={cn(modelSelectorTriggerVariants({ variant, size }), className)}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented) return;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          setOpen(true);
        }
      }}
      {...props}
    >
      {children ?? <ModelSelectorValue />}
    </PopoverTrigger>
  );
}
