import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import {
  type CachedSessionRecord,
  createSessionRecord,
  type SessionIdentity,
  sessionRecordKey,
} from "../runtime/pi-session-store.ts";
import { useTransportManager } from "../runtime/session-transport-context";

export interface SessionCacheState {
  records: Map<string, CachedSessionRecord>;
}

export interface SessionCacheController {
  ensure(identity: SessionIdentity): CachedSessionRecord;
  ensureAttached(identity: SessionIdentity): Promise<CachedSessionRecord>;
  get(key: string): CachedSessionRecord | undefined;
  quiesce(key: string): () => void;
  quiesceProject(projectId: string): () => void;
  retire(key: string): Promise<void>;
  retireProject(projectId: string): Promise<void>;
  touch(key: string): void;
  getActiveKey(): string | null;
  setActiveKey(key: string | null): void;
  setDraftMaterializing(materializing: boolean): void;
  getAllRecords(): CachedSessionRecord[];
}

interface SessionCacheSnapshot {
  records: CachedSessionRecord[];
  activeKey: string | null;
  draftMaterializing: boolean;
}

const SessionCacheContext = createContext<SessionCacheController | null>(null);
const SessionCacheSnapshotContext = createContext<SessionCacheSnapshot | null>(null);

/**
 * 持有所有 cached session records，并提供缓存生命周期管理。
 * 位于 Router 外部，不随路由变化卸载。
 *
 * 内部使用 TransportProvider 提供的 SessionTransportManager 管理 attachment leases。
 */
export function SessionCacheProvider({ children }: { children: ReactNode }) {
  const transportManager = useTransportManager();
  const controllerRef = useRef<SessionCacheController | null>(null);
  const [, forceRender] = useState(0);
  const recordsRef = useRef(new Map<string, CachedSessionRecord>());
  const activeKeyRef = useRef<string | null>(null);
  const draftMaterializingRef = useRef(false);

  if (!controllerRef.current) {
    controllerRef.current = {
      ensure(identity: SessionIdentity): CachedSessionRecord {
        const key = sessionRecordKey(identity.projectId, identity.threadId);
        let record = recordsRef.current.get(key);
        if (!record) {
          const created = createSessionRecord(identity);
          record = created;
          recordsRef.current.set(key, created);
          forceRender((n) => n + 1);
        }
        void transportManager.ensure(record).catch(() => {
          if (recordsRef.current.get(key) !== record) return;
          record.stores.connection.setState("error");
          record.stores.summary.set({ connectionState: "error" });
        });
        record.lastAccessedAt = Date.now();
        return record;
      },

      async ensureAttached(identity: SessionIdentity) {
        const controller = controllerRef.current;
        if (!controller) throw new Error("Session cache controller 尚未初始化");
        const record = controller.ensure(identity);
        await transportManager.ensure(record);
        return record;
      },

      get(key: string): CachedSessionRecord | undefined {
        return recordsRef.current.get(key);
      },

      quiesce(key: string) {
        const record = recordsRef.current.get(key);
        if (!record) return () => undefined;
        const previous = record.stores.connection.getSnapshot();
        record.stores.connection.setState("recovering");
        record.stores.summary.set({ connectionState: "recovering" });
        return () => {
          if (recordsRef.current.get(key) !== record) return;
          record.stores.connection.setState(previous);
          record.stores.summary.set({ connectionState: previous });
        };
      },

      quiesceProject(projectId: string) {
        const restores = [...recordsRef.current.values()]
          .filter((record) => record.identity.projectId === projectId)
          .map((record) => controllerRef.current?.quiesce(record.key) ?? (() => undefined));
        return () => {
          for (const restore of restores) restore();
        };
      },

      async retire(key: string) {
        const record = recordsRef.current.get(key);
        if (!record) return;
        await transportManager.retire(key);
        if (recordsRef.current.get(key) !== record) return;
        recordsRef.current.delete(key);
        if (activeKeyRef.current === key) activeKeyRef.current = null;
        forceRender((n) => n + 1);
      },

      async retireProject(projectId: string) {
        const records = [...recordsRef.current.values()].filter((record) => record.identity.projectId === projectId);
        await Promise.all(records.map((record) => transportManager.retire(record.key)));
        for (const record of records) recordsRef.current.delete(record.key);
        if (activeKeyRef.current && !recordsRef.current.has(activeKeyRef.current)) activeKeyRef.current = null;
        forceRender((n) => n + 1);
      },

      touch(key: string) {
        const record = recordsRef.current.get(key);
        if (record) record.lastAccessedAt = Date.now();
      },

      getActiveKey(): string | null {
        return activeKeyRef.current;
      },

      setActiveKey(key: string | null) {
        if (activeKeyRef.current === key) return;
        activeKeyRef.current = key;
        forceRender((n) => n + 1);
      },

      setDraftMaterializing(materializing: boolean) {
        if (draftMaterializingRef.current === materializing) return;
        draftMaterializingRef.current = materializing;
        forceRender((n) => n + 1);
      },

      getAllRecords(): CachedSessionRecord[] {
        return [...recordsRef.current.values()];
      },
    };
  }

  useEffect(() => () => void transportManager.detachAll(), [transportManager]);
  const snapshot = {
    records: [...recordsRef.current.values()],
    activeKey: activeKeyRef.current,
    draftMaterializing: draftMaterializingRef.current,
  };

  return (
    <SessionCacheContext.Provider value={controllerRef.current}>
      <SessionCacheSnapshotContext.Provider value={snapshot}>{children}</SessionCacheSnapshotContext.Provider>
    </SessionCacheContext.Provider>
  );
}

/** 读取 session cache controller，用于 ensure/retire/touch record。 */
export function useSessionCache(): SessionCacheController {
  const controller = useContext(SessionCacheContext);
  if (!controller) throw new Error("useSessionCache 必须在 SessionCacheProvider 内使用");
  return controller;
}

export function useSessionCacheSnapshot(): SessionCacheSnapshot {
  const snapshot = useContext(SessionCacheSnapshotContext);
  if (!snapshot) throw new Error("useSessionCacheSnapshot 必须在 SessionCacheProvider 内使用");
  return snapshot;
}
