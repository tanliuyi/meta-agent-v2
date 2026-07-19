"use client";

import { Slot, Slottable } from "@radix-ui/react-slot";
import { cn } from "@renderer/shared/lib/cn";
import { Button } from "@renderer/shared/ui/button";
import { Tooltip } from "@renderer/shared/ui/tooltip";
import { TooltipContent } from "@renderer/shared/ui/tooltip-content";
import { TooltipTrigger } from "@renderer/shared/ui/tooltip-trigger";
import { type ComponentPropsWithRef, forwardRef } from "react";

export type TooltipIconButtonProps = ComponentPropsWithRef<typeof Button> & {
  tooltip: string;
  side?: "top" | "bottom" | "left" | "right";
};

export const TooltipIconButton = forwardRef<HTMLButtonElement, TooltipIconButtonProps>(
  ({ children, tooltip, side = "bottom", className, ...rest }, ref) => {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            {...rest}
            className={cn("aui-button-icon size-6 p-1 active:scale-90", className)}
            ref={ref}
          >
            <Slottable>{children}</Slottable>
            <span className="aui-sr-only sr-only">{tooltip}</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent side={side}>{tooltip}</TooltipContent>
      </Tooltip>
    );
  },
);

TooltipIconButton.displayName = "TooltipIconButton";
