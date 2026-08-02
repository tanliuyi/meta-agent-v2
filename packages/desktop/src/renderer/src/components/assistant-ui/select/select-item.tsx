import * as SelectPrimitive from "@radix-ui/react-select";
import { cn } from "@renderer/shared/lib/cn";
import CheckIcon from "lucide-react/dist/esm/icons/check.mjs";
import type { ComponentPropsWithoutRef, ReactNode } from "react";

export interface SelectItemProps extends ComponentPropsWithoutRef<typeof SelectPrimitive.Item> {
  description?: ReactNode;
}

export function SelectItem({ className, children, description, ...props }: SelectItemProps) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        "relative flex w-full cursor-default items-center gap-2 rounded-xl py-2 ps-3 pe-9 text-sm outline-none select-none",
        "focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    >
      <span className="absolute end-3 flex size-4 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <CheckIcon className="size-4" />
        </SelectPrimitive.ItemIndicator>
      </span>
      {description ? (
        <span className="flex min-w-0 flex-col gap-0.5">
          <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
          <span className="text-muted-foreground truncate text-xs">{description}</span>
        </span>
      ) : (
        <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      )}
    </SelectPrimitive.Item>
  );
}
