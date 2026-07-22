import type { CachedSessionRecord } from "../runtime/pi-session-store.ts";
import { SessionProvider } from "./session-provider.tsx";
import { SessionSurface } from "./session-surface.tsx";

interface SessionCacheHostProps {
  records: CachedSessionRecord[];
  activeKey: string | null;
}

/** Mounts UI only for the active record; inactive records retain data but no React subtree. */
export function SessionCacheHost({ records, activeKey }: SessionCacheHostProps) {
  const activeRecord = activeKey ? records.find((record) => record.key === activeKey) : undefined;
  if (!activeRecord) return null;
  return (
    <SessionProvider key={activeRecord.key} record={activeRecord} active>
      <SessionSurface />
    </SessionProvider>
  );
}
