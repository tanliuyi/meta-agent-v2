import { createContext, type ReactNode, useContext, useRef } from "react";
import { SessionTransportManager } from "./session-transport-manager.ts";

const TransportContext = createContext<SessionTransportManager | null>(null);

/**
 * 创建窗口级的 SessionTransportManager 并注入 React tree。
 * 位于所有 session routes 外部，不因路由变化卸载。
 */
export function TransportProvider({ children }: { children: ReactNode }) {
  const managerRef = useRef<SessionTransportManager | null>(null);
  if (!managerRef.current) {
    managerRef.current = new SessionTransportManager();
  }
  return <TransportContext.Provider value={managerRef.current}>{children}</TransportContext.Provider>;
}

/** 读取窗口级 SessionTransportManager。 */
export function useTransportManager(): SessionTransportManager {
  const manager = useContext(TransportContext);
  if (!manager) throw new Error("useTransportManager 必须在 TransportProvider 内使用");
  return manager;
}
