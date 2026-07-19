import { ComposerPrimitive } from "@assistant-ui/react";
import { TooltipIconButton } from "@renderer/components/assistant-ui/tooltip-icon-button";
import PlusIcon from "lucide-react/dist/esm/icons/plus.mjs";

export function ComposerAddAttachment({ disabled }: { disabled?: boolean }) {
  return (
    <ComposerPrimitive.AddAttachment asChild>
      <TooltipIconButton
        tooltip="Add Attachment"
        side="bottom"
        variant="ghost"
        size="icon"
        className="aui-composer-add-attachment hover:bg-muted-foreground/15 dark:border-muted-foreground/15 dark:hover:bg-muted-foreground/30 size-7 rounded-full p-1 text-xs font-semibold"
        aria-label="Add Attachment"
        disabled={disabled}
      >
        <PlusIcon className="aui-attachment-add-icon size-4.5 stroke-[1.5px]" />
      </TooltipIconButton>
    </ComposerPrimitive.AddAttachment>
  );
}
