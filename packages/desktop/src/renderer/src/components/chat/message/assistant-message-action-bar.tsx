import { ActionBarPrimitive, AuiIf, useAuiState } from "@assistant-ui/react";
import { useNavigate } from "@tanstack/react-router";
import Check from "lucide-react/dist/esm/icons/check.mjs";
import Copy from "lucide-react/dist/esm/icons/copy.mjs";
import RotateCcw from "lucide-react/dist/esm/icons/rotate-ccw.mjs";
import Split from "lucide-react/dist/esm/icons/split.mjs";
import { useState } from "react";
import { useDesktopActions } from "../../../state/desktop-context.tsx";
import { TooltipIconButton } from "../../assistant-ui/tooltip-icon-button.tsx";
import { useSessionScope } from "../../session-context.tsx";
import { hasFinalResponseText } from "../message-part-grouping.ts";

export function AssistantMessageActionBar() {
  const visible = useAuiState((state) => {
    const pi = state.message.metadata.custom.pi;
    return (
      pi !== null &&
      typeof pi === "object" &&
      "kind" in pi &&
      pi.kind === "assistant" &&
      "sourceEntryId" in pi &&
      typeof pi.sourceEntryId === "string" &&
      !state.message.metadata.isOptimistic &&
      state.message.status?.type !== "running" &&
      hasFinalResponseText(state.message.parts)
    );
  });

  const sourceEntryId = useAuiState((state) => {
    if (!visible) return null;
    const pi = state.message.metadata.custom.pi;
    return pi !== null && typeof pi === "object" && "sourceEntryId" in pi && typeof pi.sourceEntryId === "string"
      ? pi.sourceEntryId
      : null;
  });
  const { record, active, branch, commandsReady } = useSessionScope();
  const actions = useDesktopActions();
  const navigate = useNavigate();
  const [branching, setBranching] = useState(false);

  const onBranch = () => {
    if (!visible || !sourceEntryId || !active || !commandsReady || branching) return;
    setBranching(true);
    void branch(sourceEntryId)
      .then(async (result) => {
        await actions.refreshProjectThreads(record.identity.projectId);
        await navigate({
          to: "/projects/$projectId/session/$threadId",
          params: { projectId: record.identity.projectId, threadId: result.branchThreadId },
        });
      })
      .catch(() => undefined)
      .finally(() => setBranching(false));
  };

  if (!visible) return null;

  return (
    <div className="flex min-h-7 items-center pt-1">
      <ActionBarPrimitive.Root
        data-slot="assistant-message-action-bar"
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
        <TooltipIconButton
          tooltip="从这里分支"
          side="top"
          disabled={!active || !commandsReady || branching}
          onClick={onBranch}
        >
          <Split className={branching ? "animate-in fade-in" : undefined} />
        </TooltipIconButton>
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
