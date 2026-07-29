import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn } from "@renderer/shared/lib/cn";
import * as React from "react";

export const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn("flex min-w-0 gap-0.5 overflow-x-auto [scrollbar-width:thin]", className)}
    {...props}
  />
));
TabsList.displayName = TabsPrimitive.List.displayName;
