import { createContext, useContext } from "react";
import { useStore } from "zustand";
import type { DesktopActions } from "./desktop-actions.ts";
import type { DesktopState } from "./desktop-model.ts";
import { useDesktopStore } from "./desktop-store-context.tsx";

export const DesktopActionsContext = createContext<DesktopActions | null>(null);

/** Subscribe to one stable window-level catalog projection. */
export function useDesktopSelector<T>(selector: (state: DesktopState) => T): T {
  return useStore(useDesktopStore(), selector);
}

export function useDesktopActions(): DesktopActions {
  const actions = useContext(DesktopActionsContext);
  if (!actions) throw new Error("useDesktopActions must be used inside DesktopCatalogProvider");
  return actions;
}
