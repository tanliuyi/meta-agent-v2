import { MessagePrimitive, useAui, useAuiState } from "@assistant-ui/react";
import { cn } from "@renderer/shared/lib/cn";
import { useThinkingVisibility } from "@renderer/state/thinking-visibility";
import { useCallback, useEffect, useState } from "react";
import type { ThinkingLevel } from "../../../../../shared/contracts.ts";
import { appendComposerQuote } from "../../../runtime/composer-quotes.ts";
import { MarkdownImageReferenceProvider } from "../../assistant-ui/streamdown/streamdown-image-reference.tsx";
import { useSessionScope } from "../../session-context.tsx";
import { AssistantMessageActionBar } from "./assistant-message-action-bar.tsx";
import { AssistantMessageContent } from "./assistant-message-content.tsx";
import { MessageAvatar } from "./message-avatar.tsx";

export interface PiMessageProvenance {
  provider: string;
  model: string;
  thinkingLevel?: ThinkingLevel;
}

export function AssistantMessage() {
  const aui = useAui();
  const messageId = useAuiState((state) => state.message.id);
  const threadRunning = useAuiState((state) => state.thread.isRunning);
  const isLast = useAuiState((state) => state.message.isLast);
  const messageRunning = useAuiState((state) => isPiAssistantRunning(state.message.metadata.custom));
  const runActivity = useSessionScope().record.stores.runActivity;
  const { showAvatars } = useThinkingVisibility();
  // 一轮（完整 run）只显示一个头像：仅在用户消息后或线程首条 assistant 消息展示。
  const isTurnFirst = useAuiState((state) => {
    const index = state.message.index;
    return index === 0 || state.thread.messages[index - 1]?.role === "user";
  });
  const provenanceProvider = useAuiState((state) => piAssistantProvenance(state.message.metadata.custom)?.provider);
  const provenanceModel = useAuiState((state) => piAssistantProvenance(state.message.metadata.custom)?.model);
  const provenanceThinking = useAuiState(
    (state) => piAssistantProvenance(state.message.metadata.custom)?.thinkingLevel,
  );
  const [participatedInRun, setParticipatedInRun] = useState(() => messageRunning || runActivity.hasParticipated());

  useEffect(() => {
    if (!threadRunning) runActivity.reset();
    else if (messageRunning) runActivity.markParticipated();
    setParticipatedInRun((current) => reduceRunActivityParticipation(current, threadRunning, messageRunning));
  }, [messageRunning, runActivity, threadRunning]);

  const isRunActivityRunning = threadRunning && isLast && (messageRunning || participatedInRun);
  const referenceImage = useCallback(
    (markdown: string) => appendComposerQuote(aui.thread().composer(), { text: markdown, messageId }),
    [aui, messageId],
  );
  return (
    <MessagePrimitive.Root
      data-slot="aui-assistant-message-root"
      data-role="assistant"
      className={cn(
        "fade-in slide-in-from-bottom-1 animate-in relative -mb-7 pb-7 duration-150 [contain-intrinsic-size:auto_200px] [content-visibility:auto]",
        showAvatars && "aui-assistant-message-avatar-mode",
      )}
    >
      {showAvatars && isTurnFirst && provenanceProvider !== undefined && provenanceModel !== undefined ? (
        <div data-slot="message-avatar-header" className="flex min-w-0 items-center gap-2 pb-3">
          <MessageAvatar provider={provenanceProvider} model={provenanceModel} />
          <div className="min-w-0 flex flex-col gap-1">
            <div className="message-avatar-name">{provenanceModel}</div>
            {provenanceThinking !== undefined ? (
              <div className="message-avatar-thinking text-xs text-muted-foreground">思考：{provenanceThinking}</div>
            ) : null}
          </div>
        </div>
      ) : null}
      <div data-slot="assistant-message-content-wrapper" className="min-w-0">
        <MarkdownImageReferenceProvider onReference={referenceImage}>
          <AssistantMessageContent isRunActivityRunning={isRunActivityRunning} isMessageRunning={messageRunning} />
        </MarkdownImageReferenceProvider>
        <AssistantMessageActionBar autohide={"not-last"} compact={showAvatars} />
      </div>
    </MessagePrimitive.Root>
  );
}

export function isPiAssistantRunning(custom: unknown): boolean {
  if (!custom || typeof custom !== "object" || !("pi" in custom)) return false;
  const pi = custom.pi;
  if (!pi || typeof pi !== "object" || !("status" in pi)) return false;
  const status = pi.status;
  return Boolean(status && typeof status === "object" && "type" in status && status.type === "running");
}

/** 从消息 custom 元数据提取生成该消息的 provider、模型与思考等级；notice 等无 provenance 消息返回 undefined。 */
export function piAssistantProvenance(custom: unknown): PiMessageProvenance | undefined {
  if (!custom || typeof custom !== "object" || !("pi" in custom)) return undefined;
  const pi = custom.pi;
  if (!pi || typeof pi !== "object" || !("provenance" in pi)) return undefined;
  const provenance = pi.provenance;
  if (
    !provenance ||
    typeof provenance !== "object" ||
    !("provider" in provenance) ||
    !("model" in provenance) ||
    typeof provenance.provider !== "string" ||
    typeof provenance.model !== "string"
  ) {
    return undefined;
  }
  const thinkingLevel = "thinkingLevel" in provenance ? provenance.thinkingLevel : undefined;
  return {
    provider: provenance.provider,
    model: provenance.model,
    ...(typeof thinkingLevel === "string" ? { thinkingLevel: thinkingLevel as ThinkingLevel } : {}),
  };
}

export function reduceRunActivityParticipation(
  current: boolean,
  threadRunning: boolean,
  messageRunning: boolean,
): boolean {
  if (!threadRunning) return false;
  if (messageRunning) return true;
  return current;
}
