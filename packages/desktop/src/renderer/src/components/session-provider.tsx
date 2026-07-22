import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { type ReactNode, useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import type { ThinkingLevel, WorkbenchState } from "../../../shared/contracts.ts";
import type { CachedSessionRecord } from "../runtime/pi-session-store.ts";
import { useTransportManager } from "../runtime/session-transport-context.tsx";
import { usePiSessionRuntime } from "../runtime/use-pi-session-runtime.ts";
import { SessionScopeProvider } from "./session-context.tsx";

interface SessionProviderProps {
  record: CachedSessionRecord;
  active: boolean;
  children: ReactNode;
}

/** Owns the mounted session runtime and its session-scoped view commands. */
export function SessionProvider({ record, active, children }: SessionProviderProps) {
  const transport = useTransportManager();
  const connection = useSyncExternalStore(
    record.stores.connection.subscribe,
    record.stores.connection.getSnapshot,
    record.stores.connection.getSnapshot,
  );
  const commandsReady = active && connection === "ready" && transport.hasCommittedLease(record);
  const { runtime, clearQueue: clearRuntimeQueue } = usePiSessionRuntime({ record, active, transport });
  const requireCommandsReady = useCallback(() => {
    if (!active || record.stores.connection.getSnapshot() !== "ready" || !transport.hasCommittedLease(record)) {
      throw new Error("Session is not ready for commands");
    }
  }, [active, record, transport]);
  const clearQueue = useCallback(async () => {
    requireCommandsReady();
    await clearRuntimeQueue();
  }, [clearRuntimeQueue, requireCommandsReady]);
  const branch = useCallback(
    async (sourceEntryId: string) => {
      requireCommandsReady();
      return window.desktop.sessions.branch({
        requestId: crypto.randomUUID(),
        projectId: record.identity.projectId,
        threadId: record.identity.threadId,
        sourceEntryId,
        position: "at",
      });
    },
    [record, requireCommandsReady],
  );
  const setModel = useCallback(
    async (provider: string, modelId: string) => {
      requireCommandsReady();
      await window.desktop.sessions.setModel(record.identity.projectId, record.identity.threadId, provider, modelId);
    },
    [record, requireCommandsReady],
  );
  const setThinking = useCallback(
    async (level: ThinkingLevel) => {
      requireCommandsReady();
      await window.desktop.sessions.setThinking(record.identity.projectId, record.identity.threadId, level);
    },
    [record, requireCommandsReady],
  );
  const editorTextTail = useRef(Promise.resolve());
  const syncEditorText = useCallback(
    (text: string) => {
      const task = editorTextTail.current
        .catch(() => undefined)
        .then(async () => {
          requireCommandsReady();
          await window.desktop.sessions.setEditorText(record.identity.projectId, record.identity.threadId, text);
        });
      editorTextTail.current = task;
      return task;
    },
    [record, requireCommandsReady],
  );
  const updateWorkbench = useCallback(
    (value: Partial<WorkbenchState>) => {
      const current = record.stores.workbench.getSnapshot();
      if (!current) return;
      const next = { ...current, ...value };
      record.stores.workbench.replace(next);
      void window.desktop.workbench
        .update(next)
        .catch((error: unknown) => console.error("Workbench update failed", error));
    },
    [record],
  );
  const scope = useMemo(
    () => ({
      record,
      active,
      commandsReady,
      clearQueue,
      branch,
      setModel,
      setThinking,
      syncEditorText,
      updateWorkbench,
    }),
    [active, branch, clearQueue, commandsReady, record, setModel, setThinking, syncEditorText, updateWorkbench],
  );
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <SessionScopeProvider scope={scope}>{children}</SessionScopeProvider>
    </AssistantRuntimeProvider>
  );
}
