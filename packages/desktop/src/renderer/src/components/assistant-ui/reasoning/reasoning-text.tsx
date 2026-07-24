import { cn } from "@renderer/shared/lib/cn";
import { followResizingContentToBottom } from "@renderer/shared/lib/follow-resizing-content-to-bottom";
import type { ComponentProps } from "react";
import { useContext, useEffect, useRef } from "react";
import { ReasoningPreviewContext } from "./reasoning-context.ts";

export function ReasoningText({ className, children, ...props }: ComponentProps<"div">) {
  const isPreview = useContext(ReasoningPreviewContext);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isPreview) return;
    const scrollElement = scrollRef.current;
    const contentElement = contentRef.current;
    if (!scrollElement || !contentElement) return;
    return followResizingContentToBottom(scrollElement, contentElement, {
      respectUserScroll: true,
    });
  }, [isPreview]);

  return (
    <div
      ref={scrollRef}
      data-slot="reasoning-text"
      className={cn(
        "aui-reasoning-text relative z-0 max-h-[50vh] overflow-y-auto ps-0 pt-2 pb-2 leading-relaxed text-pretty",
        "transform-gpu transition-[transform,opacity] ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:animate-none",
        "group-data-open/collapsible-content:animate-in group-data-closed/collapsible-content:animate-out",
        "group-data-open/collapsible-content:fade-in-0 group-data-closed/collapsible-content:fade-out-0",
        "group-data-open/collapsible-content:slide-in-from-top-4 group-data-closed/collapsible-content:slide-out-to-top-4",
        "group-data-open/collapsible-content:blur-in-[2px] group-data-closed/collapsible-content:blur-out-[2px]",
        "group-data-open/collapsible-content:duration-(--animation-duration) group-data-closed/collapsible-content:duration-(--animation-duration)",
        className,
      )}
      {...props}
    >
      <div ref={contentRef} className="aui-reasoning-text-content flex flex-col gap-2">
        {children}
      </div>
    </div>
  );
}
