import { AttachmentPrimitive } from "@assistant-ui/react";
import { TooltipIconButton } from "@renderer/components/assistant-ui/tooltip-icon-button";
import XIcon from "lucide-react/dist/esm/icons/x.mjs";

export function AttachmentRemove({ disabled }: { disabled?: boolean }) {
  return (
    <AttachmentPrimitive.Remove asChild>
      <TooltipIconButton
        tooltip="移除附件"
        className="aui-attachment-tile-remove border-border bg-background text-foreground hover:bg-accent hover:[&_svg]:text-destructive absolute end-1 top-1 rounded-full border opacity-100 shadow-sm"
        side="top"
        disabled={disabled}
      >
        <XIcon className="aui-attachment-remove-icon size-3 dark:stroke-[2.5px]" />
      </TooltipIconButton>
    </AttachmentPrimitive.Remove>
  );
}
