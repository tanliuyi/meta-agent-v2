import { ActionBarPrimitive, AuiIf, useAuiState } from "@assistant-ui/react";
import Check from "lucide-react/dist/esm/icons/check.mjs";
import Copy from "lucide-react/dist/esm/icons/copy.mjs";
import { TooltipIconButton } from "../../assistant-ui/tooltip-icon-button.tsx";
import { hasFinalResponseText } from "../message-part-grouping.ts";
import { formatMessageTime, formatPiUsageSummary } from "./usage-format.ts";

export function AssistantMessageActionBar({
  autohide = "not-last",
  compact = false,
}: {
  autohide?: "not-last" | "never";
  compact?: boolean;
}) {
  const visible = useAuiState((state) => {
    const pi = state.message.metadata.custom.pi;
    return (
      pi !== null &&
      typeof pi === "object" &&
      "kind" in pi &&
      pi.kind === "assistant" &&
      !state.message.metadata.isOptimistic &&
      state.message.status?.type !== "running" &&
      hasFinalResponseText(state.message.parts)
    );
  });
  const createdAtText = useAuiState((state) => {
    if (!visible) return null;
    return formatMessageTime(state.message.createdAt.getTime());
  });
  const usageText = useAuiState((state) => {
    const pi = state.message.metadata.custom.pi;
    return pi !== null && typeof pi === "object" && "usage" in pi ? formatPiUsageSummary(pi.usage) : null;
  });

  if (!visible) return null;

  const metadataText = [createdAtText, usageText].filter((part): part is string => part !== null).join(" · ");

  return (
    <div className={compact ? "flex min-h-7 items-center" : "flex min-h-7 items-center pt-1"}>
      <ActionBarPrimitive.Root
        data-slot="assistant-message-action-bar"
        autohide={autohide}
        className="animate-in fade-in flex items-center gap-1 text-muted-foreground duration-200"
      >
        <ActionBarPrimitive.Copy asChild>
          <TooltipIconButton tooltip="复制消息" side="top">
            <AuiIf condition={(state) => state.message.isCopied}>
              <Check className="animate-in zoom-in-50 fade-in opacity-60" />
            </AuiIf>
            <AuiIf condition={(state) => !state.message.isCopied}>
              <Copy className="animate-in zoom-in-75 fade-in opacity-60" />
            </AuiIf>
          </TooltipIconButton>
        </ActionBarPrimitive.Copy>

        {metadataText !== "" ? (
          <span data-slot="assistant-message-metadata" className="min-w-0 text-xs text-muted-foreground/60">
            {metadataText}
          </span>
        ) : null}
      </ActionBarPrimitive.Root>
    </div>
  );
}
