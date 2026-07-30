import { Slot } from "@radix-ui/react-slot";
import { cn } from "@renderer/shared/lib/cn";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";

export const badgeVariants = cva(
  "inline-flex items-center justify-center gap-1 rounded-md text-xs font-medium transition-colors [&_svg]:size-3 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        outline:
          "border-input text-muted-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground border bg-transparent",
        secondary: "bg-secondary text-secondary-foreground [a&]:hover:bg-secondary/80",
        muted: "bg-muted text-muted-foreground [a&]:hover:bg-muted/80 [a&]:hover:text-foreground",
        ghost: "text-muted-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground bg-transparent",
        info: "bg-info/10 text-info [a&]:hover:bg-info/15",
        warning: "bg-warning/10 text-warning [a&]:hover:bg-warning/15",
        success: "bg-success/10 text-success [a&]:hover:bg-success/15",
        destructive: "bg-destructive/10 text-destructive [a&]:hover:bg-destructive/15",
      },
      size: {
        sm: "px-1.5 py-0.5",
        default: "px-2 py-1",
        lg: "px-2.5 py-1.5 text-sm",
      },
    },
    defaultVariants: {
      variant: "outline",
      size: "default",
    },
  },
);

export type BadgeProps = ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & {
    asChild?: boolean;
  };

export function Badge({ className, variant, size, asChild = false, ...props }: BadgeProps) {
  const Comp = asChild ? Slot : "span";

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      data-size={size}
      className={cn(badgeVariants({ variant, size }), className)}
      {...props}
    />
  );
}
