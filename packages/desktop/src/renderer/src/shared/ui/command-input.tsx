import { cn } from "@renderer/shared/lib/cn";
import { Command as CommandPrimitive } from "cmdk";
import Search from "lucide-react/dist/esm/icons/search.mjs";
import type { ComponentProps } from "react";

export function CommandInput({ className, ...props }: ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div data-slot="command-input-wrapper" className="flex h-8 items-center gap-2 border-b px-2">
      <Search className="size-3.5 shrink-0 opacity-50" aria-hidden="true" />
      <CommandPrimitive.Input
        data-slot="command-input"
        className={cn(
          "flex h-8 w-full rounded-md bg-transparent py-1 text-xs outline-hidden placeholder:text-muted-foreground focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...props}
      />
    </div>
  );
}
