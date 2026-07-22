import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { type ReactNode, useCallback, useMemo } from "react";
import type { WorkbenchState } from "../../../shared/contracts.ts";
import type { CachedSessionRecord } from "../runtime/pi-session-store.ts";
import { useTransportManager } from "../runtime/session-transport-context.tsx";
import { usePiSessionRuntime } from "../runtime/use-pi-session-runtime.ts";
import { SessionScopeProvider } from "./session-context.tsx";

interface SessionProviderProps {
  record: CachedSessionRecord;
  active: boolean;
  children: ReactNode;
}

/** Owns one session runtime and the session-scoped view commands for a cached Activity. */
export function SessionProvider({ record, active, children }: SessionProviderProps) {
  const transport = useTransportManager();
  const runtime = usePiSessionRuntime({ record, active, transport });
  const clearQueue = useCallback(async () => {
    if (!active || !transport.hasCommittedLease(record)) throw new Error("Session is not ready for commands");
    await window.desktop.sessions.clearQueue(record.identity.projectId, record.identity.threadId);
  }, [active, record, transport]);
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
    () => ({ record, active, clearQueue, updateWorkbench }),
    [active, clearQueue, record, updateWorkbench],
  );
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <SessionScopeProvider scope={scope}>{children}</SessionScopeProvider>
    </AssistantRuntimeProvider>
  );
}
