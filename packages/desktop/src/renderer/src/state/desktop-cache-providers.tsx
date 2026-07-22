import { type ReactNode } from "react";
import { TransportProvider } from "../runtime/session-transport-context";
import { SessionCacheProvider } from "./session-cache-context";

/**
 * 为 root render 注入 session cache 基础设施。
 * 位于 app 与 runtime 之间，确保 app 不直接导入 runtime。
 */
export function DesktopCacheProviders({ children }: { children: ReactNode }) {
  return (
    <TransportProvider>
      <SessionCacheProvider>{children}</SessionCacheProvider>
    </TransportProvider>
  );
}
