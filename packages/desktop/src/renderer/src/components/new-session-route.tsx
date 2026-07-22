import {
  AssistantRuntimeProvider,
  type ExternalStoreAdapter,
  type ThreadMessage,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { useMemo } from "react";
import { imageAttachmentAdapter } from "../runtime/image-attachments.ts";
import { NewSessionSurface } from "./new-session-surface.tsx";

const EMPTY_MESSAGES: readonly ThreadMessage[] = [];

/** Owns the assistant-ui Composer state for the single renderer-only draft. */
export function NewSessionRoute() {
  const adapter = useMemo<ExternalStoreAdapter<ThreadMessage>>(
    () => ({
      messages: EMPTY_MESSAGES,
      isSendDisabled: true,
      onNew: rejectUnexpectedDraftSend,
      adapters: { attachments: imageAttachmentAdapter },
      unstable_enableToolInvocations: false,
    }),
    [],
  );
  const runtime = useExternalStoreRuntime(adapter);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <NewSessionSurface runtime={runtime} />
    </AssistantRuntimeProvider>
  );
}

async function rejectUnexpectedDraftSend(): Promise<void> {
  throw new Error("Draft submission must be handled before creating a Pi session");
}
