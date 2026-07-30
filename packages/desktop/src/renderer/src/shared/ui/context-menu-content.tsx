import * as ContextMenuPrimitive from "@radix-ui/react-context-menu";
import type { ComponentProps } from "react";
import { cn } from "../lib/cn.ts";

type ContextMenuContentProps = ComponentProps<typeof ContextMenuPrimitive.Content> & {
  portalProps?: Omit<ComponentProps<typeof ContextMenuPrimitive.Portal>, "children" | "forceMount">;
};

export function ContextMenuContent({ className, forceMount, portalProps, ...props }: ContextMenuContentProps) {
  return (
    <ContextMenuPrimitive.Portal {...portalProps} forceMount={forceMount}>
      <ContextMenuPrimitive.Content
        forceMount={forceMount}
        className={cn(
          "bg-popover/95 text-popover-foreground data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:animate-out z-(--stack-menu) min-w-32 overflow-hidden rounded-xl border p-1 shadow-(--elevation-popover) backdrop-blur-sm",
          className,
        )}
        {...props}
      />
    </ContextMenuPrimitive.Portal>
  );
}
