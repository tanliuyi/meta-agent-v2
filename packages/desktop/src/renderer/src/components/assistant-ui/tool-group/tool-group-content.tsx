import { cn } from "@renderer/shared/lib/cn";
import { CollapsibleContent } from "@renderer/shared/ui/collapsible-content";
import type { ComponentProps } from "react";

export function ToolGroupContent({ className, children, ...props }: ComponentProps<typeof CollapsibleContent>) {
  return (
    <CollapsibleContent
      data-slot="tool-group-content"
      className={cn(
        "aui-tool-group-content relative overflow-hidden text-sm outline-none",
        "group/collapsible-content ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:animate-none",
        "data-closed:animate-collapsible-up data-open:animate-collapsible-down",
        "data-closed:fill-mode-forwards data-closed:pointer-events-none",
        "data-open:duration-(--animation-duration) data-closed:duration-(--animation-duration)",
        className,
      )}
      {...props}
    >
      <div
        className={cn(
          "mt-2 flex flex-col gap-2",
          "group-data-[variant=ghost]/tool-group-root:mt-1 group-data-[variant=ghost]/tool-group-root:gap-1",
          "group-data-[variant=outline]/tool-group-root:mt-3 group-data-[variant=outline]/tool-group-root:border-t group-data-[variant=outline]/tool-group-root:px-4 group-data-[variant=outline]/tool-group-root:pt-3",
          "group-data-[variant=muted]/tool-group-root:mt-3 group-data-[variant=muted]/tool-group-root:border-t group-data-[variant=muted]/tool-group-root:px-4 group-data-[variant=muted]/tool-group-root:pt-3",
          "[&>*]:animate-in [&>*]:fade-in-0 [&>*]:blur-in-[2px] [&>*]:slide-in-from-top-1 [&>*]:duration-(--animation-duration) [&>*]:ease-[cubic-bezier(0.32,0.72,0,1)] [&>*]:motion-reduce:animate-none",
          "[&>*:nth-child(2)]:[animation-delay:40ms] [&>*:nth-child(3)]:[animation-delay:80ms]",
          "[&>*:nth-child(4)]:[animation-delay:120ms] [&>*:nth-child(n+5)]:[animation-delay:160ms]",
        )}
      >
        {children}
      </div>
    </CollapsibleContent>
  );
}
