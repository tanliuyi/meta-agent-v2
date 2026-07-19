import { cn } from "@renderer/shared/lib/cn";
import { CollapsibleTrigger } from "@renderer/shared/ui/collapsible-trigger";
import ChevronDownIcon from "lucide-react/dist/esm/icons/chevron-down.mjs";
import LoaderIcon from "lucide-react/dist/esm/icons/loader.mjs";
import type { ComponentProps } from "react";

export function ToolGroupTrigger({
  count,
  active = false,
  className,
  ...props
}: ComponentProps<typeof CollapsibleTrigger> & {
  count: number;
  active?: boolean;
}) {
  const label = `${count} tool ${count === 1 ? "call" : "calls"}`;

  return (
    <CollapsibleTrigger
      data-slot="tool-group-trigger"
      className={cn(
        "aui-tool-group-trigger group/trigger flex origin-left items-center gap-2 text-sm transition-[color,scale] active:scale-[0.98]",
        "group-data-[variant=ghost]/tool-group-root:text-muted-foreground group-data-[variant=ghost]/tool-group-root:hover:text-foreground group-data-[variant=ghost]/tool-group-root:py-1.5",
        "group-data-[variant=outline]/tool-group-root:w-full group-data-[variant=outline]/tool-group-root:px-4",
        "group-data-[variant=muted]/tool-group-root:w-full group-data-[variant=muted]/tool-group-root:px-4",
        className,
      )}
      {...props}
    >
      {active ? (
        <LoaderIcon
          data-slot="tool-group-trigger-loader"
          className="aui-tool-group-trigger-loader size-3 shrink-0 animate-spin [animation-duration:0.6s]"
        />
      ) : null}
      <span
        data-slot="tool-group-trigger-label"
        className={cn(
          "aui-tool-group-trigger-label-wrapper relative inline-block text-start leading-none font-medium",
          "group-data-[variant=ghost]/tool-group-root:font-normal",
          "group-data-[variant=outline]/tool-group-root:grow group-data-[variant=muted]/tool-group-root:grow",
        )}
      >
        <span className="text-sm">{label}</span>
        {active ? (
          <span
            aria-hidden
            data-slot="tool-group-trigger-shimmer"
            className="aui-tool-group-trigger-shimmer shimmer pointer-events-none absolute inset-0 text-sm [--shimmer-color:hsl(var(--foreground))] motion-reduce:animate-none"
          >
            {label}
          </span>
        ) : null}
      </span>
      <ChevronDownIcon
        data-slot="tool-group-trigger-chevron"
        className={cn(
          "aui-tool-group-trigger-chevron size-3 shrink-0 -rotate-90",
          "transition-transform duration-(--animation-duration) ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none",
          "group-data-open/trigger:rotate-0 group-data-panel-open/trigger:rotate-0",
        )}
      />
    </CollapsibleTrigger>
  );
}
