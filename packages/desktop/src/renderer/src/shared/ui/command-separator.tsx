import { cn } from "@renderer/shared/lib/cn";
import { Command as CommandPrimitive } from "cmdk";
import type { ComponentProps } from "react";

export function CommandSeparator({ className, ...props }: ComponentProps<typeof CommandPrimitive.Separator>) {
  return (
    <CommandPrimitive.Separator
      data-slot="command-separator"
      className={cn("-mx-1 h-px bg-border", className)}
      {...props}
    />
  );
}
