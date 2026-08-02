import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import {
  type CachedSessionRecord,
  createSessionRecord,
  type SessionIdentity,
  sessionRecordKey,
} from "../runtime/pi-session-store.ts";
import { useTransportManager } from "../runtime/session-transport-context";
import { SessionHolderRegistry } from "./session-holders.ts";

export interface SessionCacheState {
  records: Map<string, CachedSessionRecord>;
}

export interface SessionCacheController {
  ensure(identity: SessionIdentity): CachedSessionRecord;
  ensureAttached(identity: SessionIdentity): Promise<CachedSessionRecord>;
  get(key: string): CachedSessionRecord | undefined;
  quiesce(key: string): Promise<() => Promise<void>>;
  quiesceProject(projectId: string): Promise<() => Promise<void>>;
  /** 次级视图（如侧边栏 tab）持有一席：导航切换不会 detach 被持有的会话。 */
  retain(key: string): void;
  /** 释放一席；无其他持有者且非路由活动会话时 detach 租约。 */
  release(key: string): void;
  retire(key: string): Promise<void>;
  retireProject(projectId: string): Promise<void>;
  touch(key: string): void;
  getActiveKey(): string | null;
  activate(identity: SessionIdentity): void;
  setActiveKey(key: string | null): void;
  setDraftMaterializing(materializing: boolean): void;
  getAllRecords(): CachedSessionRecord[];
}

const SessionCacheContext = createContext<SessionCacheController | null>(null);
const SessionCacheRecordsContext = createContext<CachedSessionRecord[] | null>(null);
const SessionCacheActiveKeyContext = createContext<string | null | undefined>(undefined);
const SessionDraftMaterializingContext = createContext<boolean | null>(null);
const MAX_HIBERNATED_SESSION_COUNT = 12;
const MAX_HIBERNATED_SESSION_BYTES = 32 * 1024 * 1024;

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
  const holdersRef = useRef(new SessionHolderRegistry());
  const draftMaterializingRef = useRef(false);
  const recordsSnapshotRef = useRef<CachedSessionRecord[]>([]);
  const recordsDirtyRef = useRef(false);
  const activateKey = (key: string | null): void => {
    const previousKey = activeKeyRef.current;
    if (previousKey === key) return;
    activeKeyRef.current = key;
    if (previousKey && !holdersRef.current.isHeld(previousKey)) {
      const previousRecord = recordsRef.current.get(previousKey);
      void transportManager.detach(previousKey).then(() => {
        if (activeKeyRef.current === previousKey || recordsRef.current.get(previousKey) !== previousRecord) return;
        if (!previousRecord?.stores.timeline.hibernate()) return;

        const hibernated = [...recordsRef.current.values()]
          .map((record) => ({ record, bytes: record.stores.timeline.getHibernatedBytes() }))
          .filter(({ bytes }) => bytes > 0)
          .sort((left, right) => left.record.lastAccessedAt - right.record.lastAccessedAt);
        let retainedCount = hibernated.length;
        let retainedBytes = hibernated.reduce((total, entry) => total + entry.bytes, 0);
        for (const entry of hibernated) {
          if (retainedCount <= MAX_HIBERNATED_SESSION_COUNT && retainedBytes <= MAX_HIBERNATED_SESSION_BYTES) break;
          if (!entry.record.stores.timeline.evictHibernated()) continue;
          retainedCount -= 1;
          retainedBytes -= entry.bytes;
        }
      });
    }
    forceRender((n) => n + 1);
  };

  if (!controllerRef.current) {
    controllerRef.current = {
      ensure(identity: SessionIdentity): CachedSessionRecord {
        const key = sessionRecordKey(identity.projectId, identity.threadId);
        let record = recordsRef.current.get(key);
        if (!record) {
          const created = createSessionRecord(identity);
          record = created;
          recordsRef.current.set(key, created);
          recordsDirtyRef.current = true;
          forceRender((n) => n + 1);
        }
        void transportManager.ensure(record).catch(() => {
          // 传输层失败时已将连接置为 recovering；fire-and-forget 的 rejection 仅需吞掉，
          // 重试由 SessionContent / 主会话的恢复循环负责（重复日志会高频刷屏）。
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

      async quiesce(key: string) {
        const record = recordsRef.current.get(key);
        if (!record) return async () => undefined;
        return transportManager.quiesce(record);
      },

      async quiesceProject(projectId: string) {
        const records = [...recordsRef.current.values()].filter((record) => record.identity.projectId === projectId);
        const restores = await Promise.all(records.map((record) => transportManager.quiesce(record)));
        return async () => {
          await Promise.all(restores.map((restore) => restore()));
        };
      },

      retain(key: string) {
        holdersRef.current.retain(key);
      },

      release(key: string) {
        const remaining = holdersRef.current.release(key);
        if (remaining === 0 && activeKeyRef.current !== key) void transportManager.detach(key);
      },

      async retire(key: string) {
        holdersRef.current.remove(key);
        const record = recordsRef.current.get(key);
        if (!record) return;
        await transportManager.retire(key);
        if (recordsRef.current.get(key) !== record) return;
        recordsRef.current.delete(key);
        recordsDirtyRef.current = true;
        if (activeKeyRef.current === key) activeKeyRef.current = null;
        forceRender((n) => n + 1);
      },

      async retireProject(projectId: string) {
        const records = [...recordsRef.current.values()].filter((record) => record.identity.projectId === projectId);
        for (const record of records) holdersRef.current.remove(record.key);
        await Promise.all(records.map((record) => transportManager.retire(record.key)));
        let recordsChanged = false;
        for (const record of records) {
          if (recordsRef.current.get(record.key) !== record) continue;
          recordsRef.current.delete(record.key);
          recordsChanged = true;
        }
        if (recordsChanged) recordsDirtyRef.current = true;
        const previousActiveKey = activeKeyRef.current;
        if (activeKeyRef.current && !recordsRef.current.has(activeKeyRef.current)) activeKeyRef.current = null;
        if (recordsChanged || previousActiveKey !== activeKeyRef.current) forceRender((n) => n + 1);
      },

      touch(key: string) {
        const record = recordsRef.current.get(key);
        if (record) record.lastAccessedAt = Date.now();
      },

      getActiveKey(): string | null {
        return activeKeyRef.current;
      },

      activate(identity: SessionIdentity) {
        activateKey(sessionRecordKey(identity.projectId, identity.threadId));
      },

      setActiveKey(key: string | null) {
        activateKey(key);
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
  if (recordsDirtyRef.current) {
    recordsSnapshotRef.current = [...recordsRef.current.values()];
    recordsDirtyRef.current = false;
  }
  const recordsSnapshot = recordsSnapshotRef.current;

  return (
    <SessionCacheContext.Provider value={controllerRef.current}>
      <SessionCacheRecordsContext.Provider value={recordsSnapshot}>
        <SessionCacheActiveKeyContext.Provider value={activeKeyRef.current}>
          <SessionDraftMaterializingContext.Provider value={draftMaterializingRef.current}>
            {children}
          </SessionDraftMaterializingContext.Provider>
        </SessionCacheActiveKeyContext.Provider>
      </SessionCacheRecordsContext.Provider>
    </SessionCacheContext.Provider>
  );
}

/** 读取 session cache controller，用于 ensure/retire/touch record。 */
export function useSessionCache(): SessionCacheController {
  const controller = useContext(SessionCacheContext);
  if (!controller) throw new Error("useSessionCache 必须在 SessionCacheProvider 内使用");
  return controller;
}

export function useSessionCacheRecords(): CachedSessionRecord[] {
  const records = useContext(SessionCacheRecordsContext);
  if (!records) throw new Error("useSessionCacheRecords 必须在 SessionCacheProvider 内使用");
  return records;
}

export function useSessionCacheActiveKey(): string | null {
  const activeKey = useContext(SessionCacheActiveKeyContext);
  if (activeKey === undefined) throw new Error("useSessionCacheActiveKey 必须在 SessionCacheProvider 内使用");
  return activeKey;
}

export function useSessionDraftMaterializing(): boolean {
  const materializing = useContext(SessionDraftMaterializingContext);
  if (materializing === null) throw new Error("useSessionDraftMaterializing 必须在 SessionCacheProvider 内使用");
  return materializing;
}
