import { cn } from "@renderer/shared/lib/cn";
import type { ComponentProps } from "react";

export function ReasoningFade({
  side = "bottom",
  className,
  ...props
}: ComponentProps<"div"> & { side?: "top" | "bottom" }) {
  const directionClasses =
    side === "top"
      ? [
          "top-0 bg-[linear-gradient(to_bottom,var(--color-background),transparent)]",
          "group-data-[variant=muted]/reasoning-root:bg-[linear-gradient(to_bottom,hsl(var(--muted)/0.5),transparent)]",
        ]
      : [
          "bottom-0 bg-[linear-gradient(to_top,var(--color-background),transparent)]",
          "group-data-[variant=muted]/reasoning-root:bg-[linear-gradient(to_top,hsl(var(--muted)/0.5),transparent)]",
        ];

  return (
    <div
      data-slot="reasoning-fade"
      className={cn(
        "aui-reasoning-fade pointer-events-none absolute inset-x-0 z-(--stack-sticky-control) h-8",
        directionClasses,
        "fade-in-0 animate-in duration-(--animation-duration)",
        className,
      )}
      {...props}
    />
  );
}
