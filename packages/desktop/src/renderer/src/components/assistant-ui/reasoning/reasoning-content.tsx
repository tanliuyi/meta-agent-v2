import { cn } from "@renderer/shared/lib/cn";
import { CollapsibleContent } from "@renderer/shared/ui/collapsible-content";
import type { ComponentProps } from "react";
import { useContext } from "react";
import { ReasoningPreviewContext } from "./reasoning-context.ts";
import { ReasoningFade } from "./reasoning-fade.tsx";

export function ReasoningContent({
  className,
  children,
  fade = true,
  ...props
}: ComponentProps<typeof CollapsibleContent> & { fade?: boolean }) {
  const isPreview = useContext(ReasoningPreviewContext);

  return (
    <CollapsibleContent
      data-slot="reasoning-content"
      className={cn(
        "aui-reasoning-content text-muted-foreground relative overflow-hidden text-sm outline-none",
        "group/collapsible-content ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:animate-none",
        "data-closed:animate-collapsible-up data-open:animate-collapsible-down",
        "data-closed:fill-mode-forwards data-closed:pointer-events-none",
        "data-open:duration-(--animation-duration) data-closed:duration-(--animation-duration)",
        className,
      )}
      {...props}
    >
      {fade ? <ReasoningFade side="top" /> : null}
      {children}
      {fade && isPreview ? <ReasoningFade /> : null}
    </CollapsibleContent>
  );
}
