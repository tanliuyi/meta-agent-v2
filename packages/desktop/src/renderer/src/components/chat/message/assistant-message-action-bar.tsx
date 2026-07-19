import { ActionBarPrimitive, AuiIf, useAuiState } from "@assistant-ui/react";
import Check from "lucide-react/dist/esm/icons/check.mjs";
import Copy from "lucide-react/dist/esm/icons/copy.mjs";
import RotateCcw from "lucide-react/dist/esm/icons/rotate-ccw.mjs";
import { TooltipIconButton } from "../../assistant-ui/tooltip-icon-button.tsx";

export function AssistantMessageActionBar() {
  const visible = useAuiState((state) => {
    const pi = state.message.metadata.custom.pi;
    const lastPart = state.message.parts.at(-1);
    return (
      pi !== null &&
      typeof pi === "object" &&
      "kind" in pi &&
      pi.kind === "assistant" &&
      "sourceEntryId" in pi &&
      typeof pi.sourceEntryId === "string" &&
      !state.message.metadata.isOptimistic &&
      lastPart?.type === "text" &&
      lastPart.text.trim().length > 0
    );
  });

  if (!visible) return null;

  return (
    <div className="flex min-h-7 items-center pt-1">
      <ActionBarPrimitive.Root
        hideWhenRunning
        autohide="not-last"
        className="animate-in fade-in flex gap-1 text-muted-foreground duration-200"
      >
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
        {/* 产品约束：非最终回复不展示入口；assistant-ui reload 链路保持注册。 */}
        <AuiIf condition={(state) => state.message.isLast && state.message.status?.type === "complete"}>
          <ActionBarPrimitive.Reload asChild>
            <TooltipIconButton tooltip="重新生成" side="top">
              <RotateCcw />
            </TooltipIconButton>
          </ActionBarPrimitive.Reload>
        </AuiIf>
      </ActionBarPrimitive.Root>
    </div>
  );
}
