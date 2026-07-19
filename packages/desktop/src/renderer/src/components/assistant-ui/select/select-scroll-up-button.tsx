import * as SelectPrimitive from "@radix-ui/react-select";
import { cn } from "@renderer/shared/lib/cn";
import ChevronUpIcon from "lucide-react/dist/esm/icons/chevron-up.mjs";
import type { ComponentPropsWithoutRef } from "react";

export function SelectScrollUpButton({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollUpButton>) {
  return (
    <SelectPrimitive.ScrollUpButton
      data-slot="select-scroll-up-button"
      className={cn("flex cursor-default items-center justify-center py-1", className)}
      {...props}
    >
      <ChevronUpIcon className="size-4" />
    </SelectPrimitive.ScrollUpButton>
  );
}
