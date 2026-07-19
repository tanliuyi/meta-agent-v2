import * as SelectPrimitive from "@radix-ui/react-select";
import { cn } from "@renderer/shared/lib/cn";
import type { ComponentPropsWithoutRef } from "react";

export function SelectSeparator({ className, ...props }: ComponentPropsWithoutRef<typeof SelectPrimitive.Separator>) {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cn("bg-border -mx-1 my-1 h-px", className)}
      {...props}
    />
  );
}
