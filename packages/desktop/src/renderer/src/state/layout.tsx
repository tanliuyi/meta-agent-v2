import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import {
  normalizeSidebarWidth,
  readStoredSidebarOpen,
  readStoredSidebarWidth,
  writeStoredSidebarOpen,
  writeStoredSidebarWidth,
} from "./layout-preference.ts";

interface LayoutContextValue {
  sidebarOpen: boolean;
  sidebarWidth: number;
  setSidebarWidth(width: number): void;
  toggleSidebar(): void;
}

const LayoutContext = createContext<LayoutContextValue | undefined>(undefined);

/** 为所有 Renderer 路由共享并持久化应用级布局偏好。 */
export function LayoutProvider({ children }: { children: ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(readStoredSidebarOpen);
  const [sidebarWidth, setSidebarWidthState] = useState(readStoredSidebarWidth);

  const setSidebarWidth = useCallback((requestedWidth: number) => {
    const width = normalizeSidebarWidth(requestedWidth);
    setSidebarWidthState(width);
    writeStoredSidebarWidth(width);
  }, []);
  const toggleSidebar = useCallback(() => {
    setSidebarOpen((open) => {
      const nextOpen = !open;
      writeStoredSidebarOpen(nextOpen);
      return nextOpen;
    });
  }, []);

  const value = useMemo(
    () => ({ sidebarOpen, sidebarWidth, setSidebarWidth, toggleSidebar }),
    [sidebarOpen, sidebarWidth, setSidebarWidth, toggleSidebar],
  );
  return <LayoutContext.Provider value={value}>{children}</LayoutContext.Provider>;
}

export function useLayout(): LayoutContextValue {
  const value = useContext(LayoutContext);
  if (!value) throw new Error("useLayout must be used inside LayoutProvider");
  return value;
}
