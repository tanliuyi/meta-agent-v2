"use client";

import { cn } from "@renderer/shared/lib/cn";
import { Collapsible } from "@renderer/shared/ui/collapsible";
import type { VariantProps } from "class-variance-authority";
import type { ComponentProps, CSSProperties } from "react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { ReasoningPreviewContext } from "./reasoning-context.ts";
import { REASONING_ANIMATION_DURATION, reasoningVariants } from "./reasoning-variants.ts";

export type ReasoningRootProps = Omit<ComponentProps<typeof Collapsible>, "open" | "onOpenChange"> &
  VariantProps<typeof reasoningVariants> & {
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    defaultOpen?: boolean;
    /** 自动展开，但不启用流式预览。 */
    autoOpen?: boolean;
    /** 流式阶段自动展开并锁定底部；用户首次切换后改由用户控制。 */
    streaming?: boolean;
  };

export function ReasoningRoot({
  className,
  variant,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  defaultOpen = false,
  autoOpen,
  streaming,
  children,
  ...props
}: ReasoningRootProps) {
  const initialOpenRef = useRef(defaultOpen);
  const previousAutoOpenRef = useRef(autoOpen);
  const [userOpen, setUserOpen] = useState<boolean | null>(null);

  useLayoutEffect(() => {
    const previousAutoOpen = previousAutoOpenRef.current;
    previousAutoOpenRef.current = autoOpen;
    if (previousAutoOpen === true && autoOpen === false) setUserOpen(null);
  }, [autoOpen]);

  const isControlled = controlledOpen !== undefined;
  const isOpen = isControlled ? controlledOpen : (userOpen ?? autoOpen ?? streaming ?? initialOpenRef.current);
  const isPreview = streaming === true && isOpen && (isControlled || userOpen === null);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!isControlled) setUserOpen(open);
      controlledOnOpenChange?.(open);
    },
    [isControlled, controlledOnOpenChange],
  );

  return (
    <Collapsible
      data-slot="reasoning-root"
      data-variant={variant}
      open={isOpen}
      onOpenChange={handleOpenChange}
      className={cn("group/reasoning-root", reasoningVariants({ variant, className }))}
      style={{ "--animation-duration": `${REASONING_ANIMATION_DURATION}ms` } as CSSProperties}
      {...props}
    >
      <ReasoningPreviewContext.Provider value={isPreview}>{children}</ReasoningPreviewContext.Provider>
    </Collapsible>
  );
}
