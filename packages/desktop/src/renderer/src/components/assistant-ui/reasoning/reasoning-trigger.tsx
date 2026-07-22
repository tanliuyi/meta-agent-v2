import { cn } from "@renderer/shared/lib/cn";
import { CollapsibleTrigger } from "@renderer/shared/ui/collapsible-trigger";
import ChevronDownIcon from "lucide-react/dist/esm/icons/chevron-down.mjs";
import type { ComponentProps } from "react";

export function ReasoningTrigger({
  active,
  duration,
  hideChevron = false,
  label = "Reasoning",
  className,
  ...props
}: ComponentProps<typeof CollapsibleTrigger> & {
  active?: boolean;
  duration?: number;
  hideChevron?: boolean;
  label?: string;
}) {
  const durationText = duration ? ` (${duration}s)` : "";
  const labelText = `${label}${durationText}`;

  return (
    <CollapsibleTrigger
      data-slot="reasoning-trigger"
      className={cn(
        "aui-reasoning-trigger group/trigger border-border text-muted-foreground hover:text-foreground flex max-w-[75%] origin-left items-center gap-2  py-1.5 text-sm transition-[color,scale] active:scale-[0.98] disabled:cursor-default disabled:hover:text-muted-foreground disabled:active:scale-100",
        className,
      )}
      {...props}
    >
      <span
        data-slot="reasoning-trigger-label"
        className="aui-reasoning-trigger-label-wrapper relative inline-block leading-none tabular-nums"
      >
        <span>{labelText}</span>
        {active ? (
          <span
            aria-hidden
            data-slot="reasoning-trigger-shimmer"
            className="aui-reasoning-trigger-shimmer shimmer pointer-events-none absolute inset-0 [--shimmer-color:hsl(var(--foreground))] motion-reduce:animate-none"
          >
            {labelText}
          </span>
        ) : null}
      </span>
      {!hideChevron ? (
        <ChevronDownIcon
          data-slot="reasoning-trigger-chevron"
          className={cn(
            "aui-reasoning-trigger-chevron mt-0.5 size-4 shrink-0 opacity-0",
            "transition-[transform,opacity] duration-(--animation-duration) ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none",
            "-rotate-90 group-hover/trigger:opacity-100",
            "group-data-open/trigger:rotate-0 group-data-open/trigger:opacity-100",
            "group-data-panel-open/trigger:rotate-0 group-data-panel-open/trigger:opacity-100",
          )}
        />
      ) : null}
    </CollapsibleTrigger>
  );
}
