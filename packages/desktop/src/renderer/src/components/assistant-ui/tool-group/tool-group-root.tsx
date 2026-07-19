"use client";

import { cn } from "@renderer/shared/lib/cn";
import { Collapsible } from "@renderer/shared/ui/collapsible";
import type { VariantProps } from "class-variance-authority";
import type { ComponentProps, CSSProperties } from "react";
import { useCallback, useState } from "react";
import { TOOL_GROUP_ANIMATION_DURATION, toolGroupVariants } from "./tool-group-variants.ts";

export type ToolGroupRootProps = Omit<ComponentProps<typeof Collapsible>, "open" | "onOpenChange"> &
  VariantProps<typeof toolGroupVariants> & {
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    defaultOpen?: boolean;
  };

export function ToolGroupRoot({
  className,
  variant,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  defaultOpen = false,
  children,
  ...props
}: ToolGroupRootProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const isControlled = controlledOpen !== undefined;
  const isOpen = isControlled ? controlledOpen : uncontrolledOpen;

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!isControlled) setUncontrolledOpen(open);
      controlledOnOpenChange?.(open);
    },
    [isControlled, controlledOnOpenChange],
  );

  return (
    <Collapsible
      data-slot="tool-group-root"
      data-variant={variant ?? "outline"}
      open={isOpen}
      onOpenChange={handleOpenChange}
      className={cn(toolGroupVariants({ variant }), "group/tool-group-root", className)}
      style={{ "--animation-duration": `${TOOL_GROUP_ANIMATION_DURATION}ms` } as CSSProperties}
      {...props}
    >
      {children}
    </Collapsible>
  );
}
