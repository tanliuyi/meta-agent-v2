import { Activity } from "react";
import type { CachedSessionRecord } from "../runtime/pi-session-store.ts";
import { SessionProvider } from "./session-provider.tsx";
import { SessionSurface } from "./session-surface.tsx";

interface CachedSessionActivityProps {
  record: CachedSessionRecord;
  active: boolean;
}

/**
 * 用 React 19.2 Activity 包裹每个 cached session 的 provider/surface。
 * `mode="visible"` 表示当前 session，`mode="hidden"` 保留 state 但不交互。
 */
export function CachedSessionActivity({ record, active }: CachedSessionActivityProps) {
  return (
    <Activity name={record.key} mode={active ? "visible" : "hidden"}>
      <SessionProvider record={record} active={active}>
        <SessionSurface />
      </SessionProvider>
    </Activity>
  );
}
