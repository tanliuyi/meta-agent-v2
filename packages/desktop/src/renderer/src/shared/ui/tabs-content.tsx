import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn } from "@renderer/shared/lib/cn";
import * as React from "react";

export const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content ref={ref} className={cn("min-w-0 outline-none", className)} {...props} />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;
