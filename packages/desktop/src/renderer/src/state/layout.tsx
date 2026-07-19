import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { normalizeSidebarWidth, readStoredSidebarWidth, writeStoredSidebarWidth } from "./layout-preference.ts";

interface LayoutContextValue {
  sidebarWidth: number;
  setSidebarWidth(width: number): void;
}

const LayoutContext = createContext<LayoutContextValue | undefined>(undefined);

/** 为所有 Renderer 路由共享并持久化应用级布局偏好。 */
export function LayoutProvider({ children }: { children: ReactNode }) {
  const [sidebarWidth, setSidebarWidthState] = useState(readStoredSidebarWidth);

  const setSidebarWidth = useCallback((requestedWidth: number) => {
    const width = normalizeSidebarWidth(requestedWidth);
    setSidebarWidthState(width);
    writeStoredSidebarWidth(width);
  }, []);

  const value = useMemo(() => ({ sidebarWidth, setSidebarWidth }), [sidebarWidth, setSidebarWidth]);
  return <LayoutContext.Provider value={value}>{children}</LayoutContext.Provider>;
}

export function useLayout(): LayoutContextValue {
  const value = useContext(LayoutContext);
  if (!value) throw new Error("useLayout must be used inside LayoutProvider");
  return value;
}
