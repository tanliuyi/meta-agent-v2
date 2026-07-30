import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { cn } from "../lib/cn.ts";

const dialogFooterVariants = cva("flex", {
  variants: {
    variant: {
      default: "flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2",
      actions: "mt-3 flex-row justify-end gap-2",
    },
  },
  defaultVariants: {
    variant: "default",
  },
});

type DialogFooterProps = HTMLAttributes<HTMLDivElement> & VariantProps<typeof dialogFooterVariants>;

export function DialogFooter({ className, variant, ...props }: DialogFooterProps) {
  return <div className={cn(dialogFooterVariants({ variant }), className)} {...props} />;
}
