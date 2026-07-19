import * as SelectPrimitive from "@radix-ui/react-select";
import { cn } from "@renderer/shared/lib/cn";
import type { VariantProps } from "class-variance-authority";
import ChevronDownIcon from "lucide-react/dist/esm/icons/chevron-down.mjs";
import type { ComponentPropsWithoutRef } from "react";
import { selectTriggerVariants } from "./select-variants.ts";

export function SelectTrigger({
  className,
  variant,
  size,
  children,
  ...props
}: ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger> & VariantProps<typeof selectTriggerVariants>) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-variant={variant ?? "outline"}
      data-size={size ?? "default"}
      className={cn(selectTriggerVariants({ variant, size }), className)}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDownIcon className="size-4 opacity-50" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}
