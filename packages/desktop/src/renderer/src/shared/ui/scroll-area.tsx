import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";
import { cn } from "@renderer/shared/lib/cn";
import { ScrollBar } from "@renderer/shared/ui/scroll-bar";
import * as React from "react";

/** 组合 Radix viewport、默认滚动条与 corner，调用方仍控制 Root props。 */
export const ScrollArea = React.forwardRef<
  React.ElementRef<typeof ScrollAreaPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root>
>(({ className, children, ...props }, ref) => (
  <ScrollAreaPrimitive.Root
    ref={ref}
    className={cn("relative overflow-hidden flex flex-col items-center self-stretch", className)}
    {...props}
  >
    <ScrollAreaPrimitive.Viewport className="h-full w-full rounded-[inherit]">{children}</ScrollAreaPrimitive.Viewport>
    <ScrollBar />
    <ScrollAreaPrimitive.Corner />
  </ScrollAreaPrimitive.Root>
));
ScrollArea.displayName = ScrollAreaPrimitive.Root.displayName;
