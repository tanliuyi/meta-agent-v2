import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionControlState, ThinkingLevel, WorkbenchState } from "../../../shared/contracts.ts";
import type { CachedSessionRecord } from "../runtime/pi-session-store.ts";
import { createRecoveryLoop } from "../runtime/session-recovery.ts";
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

  // 主会话 attach/resync 失败后自动恢复：订阅连接状态，recovering 时按退避重试，
  // 响应 ready 之后的后续 recovering 转换（如 resync 失败），避免停留在“会话连接失败”。
  useEffect(() => {
    if (!active) return;
    const loop = createRecoveryLoop({
      getState: () => record.stores.connection.getSnapshot(),
      subscribe: (listener) => record.stores.connection.subscribe(listener),
      ensure: () => transport.recover(record),
    });
    return () => loop.dispose();
  }, [active, record, transport]);
  const modelsRefreshRequest = useRef<Promise<void> | null>(null);
  const [modelsRefreshing, setModelsRefreshing] = useState(false);
  const { runtime } = usePiSessionRuntime({ record, active, transport });
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
  const refreshModels = useCallback(async () => {
    requireCommandsReady();
    if (record.stores.timeline.getSnapshot().phase !== "idle") {
      throw new Error("Wait for the current response to finish before refreshing models.");
    }
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
      refreshModels,
      setModel,
      setThinking,
      updateWorkbench,
    }),
    [active, commandsReady, modelsRefreshing, record, refreshModels, setModel, setThinking, updateWorkbench],
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
