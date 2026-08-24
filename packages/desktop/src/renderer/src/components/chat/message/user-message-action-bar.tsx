import { ActionBarPrimitive, AuiIf, useAuiState } from "@assistant-ui/react";
import Check from "lucide-react/dist/esm/icons/check.mjs";
import Copy from "lucide-react/dist/esm/icons/copy.mjs";
import GitBranch from "lucide-react/dist/esm/icons/git-branch.mjs";
import { useState } from "react";
import { useToast } from "../../../shared/ui/use-toast.ts";
import { dispatchDesktop } from "../../../state/desktop-store.ts";
import { useDesktopStore } from "../../../state/desktop-store-context.tsx";
import { useSessionCache } from "../../../state/session-cache-context.tsx";
import { useSessionNavigation } from "../../../state/session-navigation.ts";
import { TooltipIconButton } from "../../assistant-ui/tooltip-icon-button.tsx";
import { useSessionScope } from "../../session-context.tsx";

export function UserMessageActionBar({ autohide = "always" }: { autohide?: "always" | "never" }) {
  const sourceEntryId = useAuiState((state) => {
    const pi = state.message.metadata.custom.pi;
    return pi !== null && typeof pi === "object" && "sourceEntryId" in pi && typeof pi.sourceEntryId === "string"
      ? pi.sourceEntryId
      : null;
  });
  const isRunning = useAuiState((state) => state.thread.isRunning);
  const attachments = useAuiState((state) => state.message.attachments ?? []);
  const { record, commandsReady } = useSessionScope();
  const navigation = useSessionNavigation();
  const cache = useSessionCache();
  const desktopStore = useDesktopStore();
  const { notify } = useToast();
  const [forking, setForking] = useState(false);

  async function forkMessage() {
    if (!sourceEntryId || isRunning || forking || !commandsReady) return;
    setForking(true);
    try {
      const result = await window.desktop.sessions.fork({ ...record.identity, entryId: sourceEntryId });
      dispatchDesktop(desktopStore, { type: "thread-catalog-upserted", thread: result.thread });
      const next = cache.ensure({ projectId: result.projectId, threadId: result.threadId });
      next.stores.composerDraft.setSnapshot({ text: result.text, attachments });
      await navigation.replaceSession(result.projectId, result.threadId);
      await cache.retire(record.key);
    } catch (error) {
      notify({
        message: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
      setForking(false);
    }
  }

  return (
    <ActionBarPrimitive.Root
      autohide={autohide}
      className="aui-user-action-bar-root animate-in fade-in flex items-center gap-1 text-muted-foreground duration-200"
    >
      {sourceEntryId ? (
        <TooltipIconButton
          tooltip="创建分支"
          className="aui-user-action-fork"
          side="top"
          disabled={isRunning || forking || !commandsReady}
          onClick={() => void forkMessage()}
        >
          <GitBranch className="animate-in zoom-in-75 fade-in opacity-60" />
        </TooltipIconButton>
      ) : null}

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
    </ActionBarPrimitive.Root>
  );
}
