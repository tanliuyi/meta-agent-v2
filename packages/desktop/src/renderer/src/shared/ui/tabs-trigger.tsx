import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn } from "@renderer/shared/lib/cn";
import * as React from "react";

export const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      "inline-flex h-[30px] min-w-max cursor-pointer items-center justify-center gap-1.5 rounded-full border-0 bg-transparent px-2.5 text-(length:--type-size-control) text-muted-foreground transition-colors",
      "hover:bg-muted/65 hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
      "data-[state=active]:bg-muted data-[state=active]:font-medium data-[state=active]:text-foreground",
      "aria-disabled:cursor-not-allowed aria-disabled:opacity-45 aria-disabled:hover:bg-transparent aria-disabled:hover:text-muted-foreground disabled:pointer-events-none disabled:opacity-50",
      "[&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:stroke-[1.8]",
      className,
    )}
    {...props}
  />
));
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;
