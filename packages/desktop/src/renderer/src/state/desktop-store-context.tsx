import { createContext, type ReactNode, useContext, useState } from "react";
import { createDesktopStore, type DesktopStore } from "./desktop-store.ts";

const DesktopStoreContext = createContext<DesktopStore | null>(null);

/** 在 renderer 窗口生命周期内保留 active thread；不写入磁盘或浏览器存储。 */
export function DesktopStoreProvider({ children }: { children: ReactNode }) {
  const [store] = useState(createDesktopStore);
  return <DesktopStoreContext.Provider value={store}>{children}</DesktopStoreContext.Provider>;
}

/** 读取窗口级 Desktop store。 */
export function useDesktopStore(): DesktopStore {
  const store = useContext(DesktopStoreContext);
  if (!store) throw new Error("Desktop store 必须在 DesktopStoreProvider 内使用");
  return store;
}
