import type { CachedSessionRecord } from "../runtime/pi-session-store.ts";
import { CachedSessionActivity } from "./cached-session-activity.tsx";

interface SessionCacheHostProps {
  records: CachedSessionRecord[];
  activeKey: string | null;
}

/**
 * 对所有已注册 record 渲染稳定 keyed activity。
 * 每个 Activity 持有独立的 SessionProvider 和 assistant-ui runtime。
 */
export function SessionCacheHost({ records, activeKey }: SessionCacheHostProps) {
  return (
    <>
      {records.map((record) => (
        <CachedSessionActivity key={record.key} record={record} active={record.key === activeKey} />
      ))}
    </>
  );
}
