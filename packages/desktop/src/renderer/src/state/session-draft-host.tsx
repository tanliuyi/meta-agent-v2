import {
  type AssistantRuntime,
  type ExternalStoreAdapter,
  type ThreadMessage,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { useEffect, useMemo } from "react";
import { createDraftRuntimeAdapter } from "./draft-session-context.tsx";
import type { SessionDraft } from "./session-draft-context.tsx";

export interface SessionDraftBinding {
  draft: SessionDraft;
  runtime: AssistantRuntime;
}

/** 每个主 session 一个：持有独立 composer runtime，并双向同步 composer 与 SessionDraft。 */
export function SessionDraftHost({
  draft,
  onReady,
}: {
  draft: SessionDraft;
  onReady(sessionKey: string, binding: SessionDraftBinding | null): void;
}) {
  const adapter = useMemo<ExternalStoreAdapter<ThreadMessage>>(createDraftRuntimeAdapter, []);
  const runtime = useExternalStoreRuntime(adapter);
  useEffect(() => {
    const composer = runtime.thread.composer;
    const sync = (): void => {
      const state = composer.getState();
      draft.setComposer(state.text, state.attachments);
    };
    const unsubscribe = composer.subscribe(sync);
    sync();
    return () => {
      unsubscribe();
      sync();
    };
  }, [draft, runtime]);
  useEffect(() => {
    onReady(draft.key, { draft, runtime });
    return () => onReady(draft.key, null);
  }, [draft, onReady, runtime]);
  return null;
}
