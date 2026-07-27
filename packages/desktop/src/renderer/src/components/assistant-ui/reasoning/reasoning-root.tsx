"use client";

import { useScrollLock } from "@assistant-ui/react";
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
    /** 是否采用 autoOpen/streaming 推导自动展开状态。 */
    autoExpand?: boolean;
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
  autoExpand = true,
  streaming,
  children,
  ...props
}: ReasoningRootProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const initialOpenRef = useRef(defaultOpen);
  const previousAutoOpenRef = useRef(autoOpen);
  const previousOpenRef = useRef<boolean | undefined>(undefined);
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const lockScroll = useScrollLock(rootRef, REASONING_ANIMATION_DURATION);

  useLayoutEffect(() => {
    const previousAutoOpen = previousAutoOpenRef.current;
    previousAutoOpenRef.current = autoOpen;
    if (previousAutoOpen === true && autoOpen === false) setUserOpen(null);
  }, [autoOpen]);

  const isControlled = controlledOpen !== undefined;
  const automaticOpen = autoExpand ? (autoOpen ?? streaming) : undefined;
  const isOpen = isControlled ? controlledOpen : (userOpen ?? automaticOpen ?? initialOpenRef.current);
  const isPreview = streaming === true && isOpen && (isControlled || userOpen === null);

  useLayoutEffect(() => {
    if (previousOpenRef.current !== undefined && previousOpenRef.current !== isOpen) lockScroll();
    previousOpenRef.current = isOpen;
  }, [isOpen, lockScroll]);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (open !== isOpen) lockScroll();
      if (!isControlled) setUserOpen(open);
      controlledOnOpenChange?.(open);
    },
    [controlledOnOpenChange, isControlled, isOpen, lockScroll],
  );

  return (
    <Collapsible
      ref={rootRef}
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
