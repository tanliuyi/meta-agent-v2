import { ActionBarPrimitive, AuiIf } from "@assistant-ui/react";
import Check from "lucide-react/dist/esm/icons/check.mjs";
import Copy from "lucide-react/dist/esm/icons/copy.mjs";
import SquarePen from "lucide-react/dist/esm/icons/square-pen.mjs";
import { TooltipIconButton } from "../../assistant-ui/tooltip-icon-button.tsx";

export function UserMessageActionBar() {
  return (
    <ActionBarPrimitive.Root
      autohide="always"
      className="aui-user-action-bar-root animate-in fade-in flex items-center gap-1 text-muted-foreground duration-200"
    >
      <ActionBarPrimitive.Edit asChild>
        <TooltipIconButton tooltip="编辑消息" className="aui-user-action-edit" side="top">
          <SquarePen />
        </TooltipIconButton>
      </ActionBarPrimitive.Edit>

      <ActionBarPrimitive.Copy asChild>
        <TooltipIconButton tooltip="复制消息" side="top">
          <AuiIf condition={(state) => state.message.isCopied}>
            <Check className="animate-in zoom-in-50 fade-in" />
          </AuiIf>
          <AuiIf condition={(state) => !state.message.isCopied}>
            <Copy className="animate-in zoom-in-75 fade-in" />
          </AuiIf>
        </TooltipIconButton>
      </ActionBarPrimitive.Copy>
    </ActionBarPrimitive.Root>
  );
}
