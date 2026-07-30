import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionControlState, ThinkingLevel, WorkbenchState } from "../../../shared/contracts.ts";
import type { CachedSessionRecord } from "../runtime/pi-session-store.ts";
import { useTransportManager } from "../runtime/session-transport-context.tsx";
import { usePiSessionRuntime } from "../runtime/use-pi-session-runtime.ts";
import { useExternalStoreSelector } from "../shared/hooks/use-external-store-selector.ts";
import { SessionScopeProvider } from "./session-context.tsx";

interface SessionProviderProps {
  record: CachedSessionRecord;
  active: boolean;
  children: ReactNode;
}

/** Owns the mounted session runtime and its session-scoped view commands. */
export function SessionProvider({ record, active, children }: SessionProviderProps) {
  const transport = useTransportManager();
  const connection = useExternalStoreSelector(record.stores.connection, selectSnapshot);
  const interaction = useExternalStoreSelector(record.stores.control, selectInteraction);
  const commandsReady =
    active && connection === "ready" && interaction !== "read-only" && transport.hasCommittedLease(record);
  const modelsRefreshRequested = useRef(false);
  const modelsRefreshRequest = useRef<Promise<void> | null>(null);
  const [modelsRefreshing, setModelsRefreshing] = useState(false);
  const { runtime, clearQueue: clearRuntimeQueue } = usePiSessionRuntime({ record, active, transport });
  const requireCommandsReady = useCallback(() => {
    if (
      !active ||
      record.stores.connection.getSnapshot() !== "ready" ||
      record.stores.control.getSnapshot()?.interaction === "read-only" ||
      !transport.hasCommittedLease(record)
    ) {
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
  const refreshModels = useCallback(async () => {
    requireCommandsReady();
    const existing = modelsRefreshRequest.current;
    if (existing) return existing;
    setModelsRefreshing(true);
    const request = Promise.resolve().then(() =>
      window.desktop.sessions.refreshModels(record.identity.projectId, record.identity.threadId),
    );
    const tracked = request.finally(() => {
      if (modelsRefreshRequest.current !== tracked) return;
      modelsRefreshRequest.current = null;
      setModelsRefreshing(false);
    });
    modelsRefreshRequest.current = tracked;
    return tracked;
  }, [record, requireCommandsReady]);
  useEffect(() => {
    if (!commandsReady || modelsRefreshRequested.current) return;
    modelsRefreshRequested.current = true;
    void refreshModels().catch((error: unknown) => {
      modelsRefreshRequested.current = false;
      console.error("Session model refresh failed", error);
    });
  }, [commandsReady, refreshModels]);
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
      modelsRefreshing,
      clearQueue,
      branch,
      refreshModels,
      setModel,
      setThinking,
      updateWorkbench,
    }),
    [
      active,
      branch,
      clearQueue,
      commandsReady,
      modelsRefreshing,
      record,
      refreshModels,
      setModel,
      setThinking,
      updateWorkbench,
    ],
  );
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <SessionScopeProvider scope={scope}>{children}</SessionScopeProvider>
    </AssistantRuntimeProvider>
  );
}

function selectSnapshot<T>(snapshot: T): T {
  return snapshot;
}

function selectInteraction(control: SessionControlState | null): SessionControlState["interaction"] {
  return control?.interaction;
}
