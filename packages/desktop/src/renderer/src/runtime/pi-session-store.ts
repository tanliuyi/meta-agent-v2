import type { PiThreadSnapshot, SessionControlState, WorkbenchState } from "../../../shared/contracts.ts";
import { PiThreadStore } from "./pi-thread-store.ts";

/**
 * 一个 cached session 持有的所有领域 store。
 * record 生命周期内持久存在，不依赖当前 session React subtree 是否挂载。
 */
export interface SessionRecordStores {
  readonly timeline: PiThreadStore;
  readonly control: SessionControlStore;
  readonly workbench: WorkbenchStore;
  readonly summary: SessionSummaryStore;
  readonly runActivity: SessionRunActivityStore;
  readonly connection: SessionConnectionStore;
}

export interface SessionControlStore {
  getSnapshot(): SessionControlState | null;
  replace(control: SessionControlState): void;
  apply(control: SessionControlState): void;
  subscribe(listener: () => void): () => void;
}

export interface WorkbenchStore {
  getSnapshot(): WorkbenchState | null;
  replace(workbench: WorkbenchState): void;
  subscribe(listener: () => void): () => void;
}

export interface SessionSummaryStore {
  getSnapshot(): CachedSessionSummary;
  setRunning(running: boolean): void;
  setConnectionState(state: SessionConnectionState): void;
  setComposerDirty(dirty: boolean): void;
  set(value: Partial<CachedSessionSummary>): void;
  subscribe(listener: () => void): () => void;
}

export interface SessionRunActivityStore {
  hasParticipated(): boolean;
  markParticipated(): void;
  reset(): void;
  sync(snapshot: PiThreadSnapshot): void;
}

export type SessionConnectionState = "attaching" | "ready" | "recovering" | "error";

export interface CachedSessionSummary {
  composerEmpty: boolean;
  running: boolean;
  loading: boolean;
  hasPendingAttachments: boolean;
  connectionState: SessionConnectionState;
}

export interface SessionConnectionStore {
  getSnapshot(): SessionConnectionState;
  setState(state: SessionConnectionState): void;
  subscribe(listener: () => void): () => void;
}

export interface SessionIdentity {
  projectId: string;
  threadId: string;
}

export interface CachedSessionRecord {
  readonly key: string;
  readonly identity: SessionIdentity;
  generation: number;
  readonly stores: SessionRecordStores;
  lastAccessedAt: number;
}

export function createSessionRecord(identity: SessionIdentity): CachedSessionRecord {
  const key = sessionRecordKey(identity.projectId, identity.threadId);
  return {
    key,
    identity,
    generation: 1,
    stores: createSessionRecordStores(),
    lastAccessedAt: Date.now(),
  };
}

export function sessionRecordKey(projectId: string, threadId: string): string {
  // Use NUL separator to avoid ambiguity with path characters
  return `${projectId}\u0000${threadId}`;
}

export function parseSessionRecordKey(key: string): SessionIdentity | null {
  const separator = key.indexOf("\u0000");
  if (separator === -1) return null;
  return {
    projectId: key.slice(0, separator),
    threadId: key.slice(separator + 1),
  };
}

export function createSessionRecordStores(): SessionRecordStores {
  return {
    timeline: new PiThreadStore(),
    control: createControlStore(),
    workbench: createWorkbenchStore(),
    summary: createSummaryStore(),
    runActivity: createRunActivityStore(),
    connection: createConnectionStore(),
  };
}

function createControlStore(): SessionControlStore {
  let control: SessionControlState | null = null;
  const listeners = new Set<() => void>();

  return {
    getSnapshot() {
      return control;
    },
    replace(value: SessionControlState) {
      control = value;
      for (const listener of listeners) listener();
    },
    apply(value: SessionControlState) {
      if (control && control.revision >= value.revision) return;
      control = value;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function createWorkbenchStore(): WorkbenchStore {
  let workbench: WorkbenchState | null = null;
  const listeners = new Set<() => void>();

  return {
    getSnapshot() {
      return workbench;
    },
    replace(value: WorkbenchState) {
      workbench = value;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function createSummaryStore(): SessionSummaryStore {
  let summary: CachedSessionSummary = {
    composerEmpty: true,
    running: false,
    loading: false,
    hasPendingAttachments: false,
    connectionState: "attaching",
  };
  const listeners = new Set<() => void>();

  return {
    getSnapshot() {
      return summary;
    },
    setRunning(running: boolean) {
      summary = { ...summary, running };
      for (const listener of listeners) listener();
    },
    setConnectionState(state: SessionConnectionState) {
      summary = { ...summary, connectionState: state };
      for (const listener of listeners) listener();
    },
    setComposerDirty(dirty: boolean) {
      summary = { ...summary, composerEmpty: !dirty };
      for (const listener of listeners) listener();
    },
    set(value: Partial<CachedSessionSummary>) {
      summary = { ...summary, ...value };
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function createRunActivityStore(): SessionRunActivityStore {
  let participated = false;

  return {
    hasParticipated() {
      return participated;
    },
    markParticipated() {
      participated = true;
    },
    reset() {
      participated = false;
    },
    sync(snapshot: PiThreadSnapshot) {
      if (snapshot.phase !== "running" && snapshot.phase !== "retrying") {
        participated = false;
        return;
      }
      const lastAssistant = snapshot.nodes.findLast((node) => node.kind === "assistant");
      if (lastAssistant?.status.type === "running") participated = true;
    },
  };
}

function createConnectionStore(): SessionConnectionStore {
  let state: SessionConnectionState = "attaching";
  const listeners = new Set<() => void>();

  return {
    getSnapshot() {
      return state;
    },
    setState(value: SessionConnectionState) {
      state = value;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
