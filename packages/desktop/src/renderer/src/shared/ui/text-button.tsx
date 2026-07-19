import { Slot } from "@radix-ui/react-slot";
import { cn } from "@renderer/shared/lib/cn";
import * as React from "react";

export interface TextButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  asChild?: boolean;
}

export const TextButton = React.forwardRef<HTMLButtonElement, TextButtonProps>(
  ({ asChild = false, className, type = "button", ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        ref={ref}
        type={type}
        className={cn(
          "inline-flex appearance-none items-center justify-center gap-1 border-0 bg-transparent p-0 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-3.5 [&_svg]:shrink-0",
          className,
        )}
        {...props}
      />
    );
  },
);
TextButton.displayName = "TextButton";
