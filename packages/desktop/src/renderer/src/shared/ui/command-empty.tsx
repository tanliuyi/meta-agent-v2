import { cn } from "@renderer/shared/lib/cn";
import { Command as CommandPrimitive } from "cmdk";
import type { ComponentProps } from "react";

export function CommandEmpty({ className, ...props }: ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className={cn("py-5 text-center text-xs", className)}
      {...props}
    />
  );
}
