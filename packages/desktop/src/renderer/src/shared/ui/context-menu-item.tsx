import * as ContextMenuPrimitive from "@radix-ui/react-context-menu";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "../lib/cn.ts";

const contextMenuItemVariants = cva(
  "flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1 text-sm outline-none select-none data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:size-3.5 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground",
        destructive:
          "text-destructive hover:bg-destructive/10 hover:text-destructive focus:bg-destructive/10 focus:text-destructive",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

type ContextMenuItemProps = ComponentProps<typeof ContextMenuPrimitive.Item> &
  VariantProps<typeof contextMenuItemVariants>;

export function ContextMenuItem({ className, variant, ...props }: ContextMenuItemProps) {
  return <ContextMenuPrimitive.Item className={cn(contextMenuItemVariants({ variant }), className)} {...props} />;
}
