import { createContext, type ReactNode, useContext, useMemo, useSyncExternalStore } from "react";
import type { WorkbenchState } from "../../../shared/contracts.ts";
import type { CachedSessionRecord } from "../runtime/pi-session-store.ts";

interface SessionScope {
  record: CachedSessionRecord;
  active: boolean;
  clearQueue(): Promise<void>;
  updateWorkbench(value: Partial<WorkbenchState>): void;
}

const SessionScopeContext = createContext<SessionScope | null>(null);

export function SessionScopeProvider({ scope, children }: { scope: SessionScope; children: ReactNode }) {
  return <SessionScopeContext.Provider value={scope}>{children}</SessionScopeContext.Provider>;
}

export function useSessionScope(): SessionScope {
  const scope = useContext(SessionScopeContext);
  if (!scope) throw new Error("Session session scope is unavailable");
  return scope;
}

export function useSessionControl() {
  const { record } = useSessionScope();
  return useSyncExternalStore(
    record.stores.control.subscribe,
    record.stores.control.getSnapshot,
    record.stores.control.getSnapshot,
  );
}

export function useSessionTimeline() {
  const { record } = useSessionScope();
  return useSyncExternalStore(
    record.stores.timeline.subscribe,
    record.stores.timeline.getSnapshot,
    record.stores.timeline.getSnapshot,
  );
}

export function useSessionWorkbench() {
  const { record } = useSessionScope();
  return useSyncExternalStore(
    record.stores.workbench.subscribe,
    record.stores.workbench.getSnapshot,
    record.stores.workbench.getSnapshot,
  );
}

export function useSessionConnection() {
  const { record } = useSessionScope();
  return useSyncExternalStore(
    record.stores.connection.subscribe,
    record.stores.connection.getSnapshot,
    record.stores.connection.getSnapshot,
  );
}

export function useSessionSummary() {
  const { record } = useSessionScope();
  return useSyncExternalStore(
    record.stores.summary.subscribe,
    record.stores.summary.getSnapshot,
    record.stores.summary.getSnapshot,
  );
}

export function useSessionIdentity() {
  const { record } = useSessionScope();
  return useMemo(() => record.identity, [record]);
}
