import * as CollapsiblePrimitive from "@radix-ui/react-collapsible";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "../lib/cn.ts";

const collapsibleContentVariants = cva(null, {
  variants: {
    animation: {
      none: null,
      height:
        "data-closed:animate-collapsible-up data-open:animate-collapsible-down data-open:duration-(--animation-duration) data-closed:duration-(--animation-duration) overflow-hidden",
      persistent:
        "data-closed:animate-collapsible-up data-open:animate-collapsible-down overflow-hidden data-closed:pointer-events-none data-closed:fill-mode-forwards motion-reduce:animate-none",
    },
  },
  defaultVariants: {
    animation: "none",
  },
});

type CollapsibleContentProps = ComponentProps<typeof CollapsiblePrimitive.Content> &
  VariantProps<typeof collapsibleContentVariants>;

export function CollapsibleContent({ animation, className, ...props }: CollapsibleContentProps) {
  return (
    <CollapsiblePrimitive.Content className={cn(collapsibleContentVariants({ animation }), className)} {...props} />
  );
}
