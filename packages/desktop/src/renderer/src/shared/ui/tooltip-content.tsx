"use client";

import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cn } from "@renderer/shared/lib/cn";
import * as React from "react";

/** 统一通过 Radix Portal 渲染浮层，避免 tooltip 被工作区 overflow 裁剪。 */
export const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        "z-(--stack-tooltip) overflow-hidden rounded-xl border border-border bg-popover px-3 py-1.5 text-xs text-foreground",
        className,
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;
