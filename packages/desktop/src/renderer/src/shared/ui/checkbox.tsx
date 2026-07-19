import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { cn } from "@renderer/shared/lib/cn";
import Check from "lucide-react/dist/esm/icons/check.mjs";
import * as React from "react";

export const Checkbox = React.forwardRef<
  React.ElementRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    className={cn(
      "border-input bg-background text-primary focus-visible:ring-ring inline-flex size-4 shrink-0 items-center justify-center rounded-sm border shadow-sm focus-visible:outline-none focus-visible:ring-1 disabled:cursor-not-allowed disabled:opacity-50",
      className,
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator>
      <Check className="size-3.5" />
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
));
Checkbox.displayName = CheckboxPrimitive.Root.displayName;
