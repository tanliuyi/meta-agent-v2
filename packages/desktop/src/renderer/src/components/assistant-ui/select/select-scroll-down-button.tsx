import * as SelectPrimitive from "@radix-ui/react-select";
import { cn } from "@renderer/shared/lib/cn";
import ChevronDownIcon from "lucide-react/dist/esm/icons/chevron-down.mjs";
import type { ComponentPropsWithoutRef } from "react";

export function SelectScrollDownButton({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollDownButton>) {
  return (
    <SelectPrimitive.ScrollDownButton
      data-slot="select-scroll-down-button"
      className={cn("flex cursor-default items-center justify-center py-1", className)}
      {...props}
    >
      <ChevronDownIcon className="size-4" />
    </SelectPrimitive.ScrollDownButton>
  );
}
