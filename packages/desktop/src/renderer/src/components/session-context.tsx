import { createContext, type ReactNode, useContext, useMemo } from "react";
import type {
  PiThreadSnapshot,
  SessionBranchResult,
  SessionControlState,
  ThinkingLevel,
  WorkbenchState,
} from "../../../shared/contracts.ts";
import type { CachedSessionRecord } from "../runtime/pi-session-store.ts";
import { useExternalStoreSelector } from "../shared/hooks/use-external-store-selector.ts";

interface SessionScope {
  record: CachedSessionRecord;
  active: boolean;
  commandsReady: boolean;
  modelsRefreshing: boolean;
  clearQueue(): Promise<void>;
  branch(sourceEntryId: string): Promise<SessionBranchResult>;
  refreshModels(): Promise<void>;
  setModel(provider: string, modelId: string): Promise<void>;
  setThinking(level: ThinkingLevel): Promise<void>;
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
  return useExternalStoreSelector(record.stores.control, selectSnapshot);
}

export function useSessionControlSelector<T>(selector: (control: SessionControlState | null) => T): T {
  const { record } = useSessionScope();
  return useExternalStoreSelector(record.stores.control, selector);
}

export function useSessionTimeline() {
  const { record } = useSessionScope();
  return useExternalStoreSelector(record.stores.timeline, selectSnapshot);
}

export function useSessionTimelineSelector<T>(selector: (timeline: PiThreadSnapshot) => T): T {
  const { record } = useSessionScope();
  return useExternalStoreSelector(record.stores.timeline, selector);
}

export function useSessionWorkbench() {
  const { record } = useSessionScope();
  return useExternalStoreSelector(record.stores.workbench, selectSnapshot);
}

export function useSessionWorkbenchSelector<T>(selector: (workbench: WorkbenchState | null) => T): T {
  const { record } = useSessionScope();
  return useExternalStoreSelector(record.stores.workbench, selector);
}

export function useSessionConnection() {
  const { record } = useSessionScope();
  return useExternalStoreSelector(record.stores.connection, selectSnapshot);
}

export function useSessionSummary() {
  const { record } = useSessionScope();
  return useExternalStoreSelector(record.stores.summary, selectSnapshot);
}

function selectSnapshot<T>(snapshot: T): T {
  return snapshot;
}

export function useSessionIdentity() {
  const { record } = useSessionScope();
  return useMemo(() => record.identity, [record]);
}
