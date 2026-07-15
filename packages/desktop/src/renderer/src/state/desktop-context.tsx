import { createContext, useContext, type ReactNode } from "react";
import type { DesktopContextValue } from "./desktop-model.ts";
import { useDesktopController } from "./use-desktop-controller.ts";

const DesktopContext = createContext<DesktopContextValue | null>(null);

/** 向 renderer 组件树注入 Desktop controller。 */
export function DesktopProvider({ children }: { children: ReactNode }) {
	return <DesktopContext.Provider value={useDesktopController()}>{children}</DesktopContext.Provider>;
}

/** 读取 Desktop 工作台状态。 */
export function useDesktop(): DesktopContextValue {
	const value = useContext(DesktopContext);
	if (!value) throw new Error("useDesktop 必须在 DesktopProvider 内使用");
	return value;
}
