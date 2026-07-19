import { cn } from "@renderer/shared/lib/cn";
import { Command as CommandPrimitive } from "cmdk";
import type { ComponentProps } from "react";

export function CommandList({ className, ...props }: ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      data-slot="command-list"
      className={cn("max-h-[300px] scroll-py-1 overflow-x-hidden overflow-y-auto", className)}
      {...props}
    />
  );
}
