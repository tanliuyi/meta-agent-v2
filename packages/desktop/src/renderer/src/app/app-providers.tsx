import { TooltipProvider } from "@renderer/shared/ui/tooltip-provider";
import { DesktopStoreProvider } from "@renderer/state/desktop-store-context";
import { LayoutProvider } from "@renderer/state/layout";
import { ThemeProvider } from "@renderer/state/theme";
import type { ReactNode } from "react";

/** 注入所有路由共享的轻量 UI provider，不初始化 Desktop session runtime。 */
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <DesktopStoreProvider>
      <ThemeProvider>
        <LayoutProvider>
          <TooltipProvider delayDuration={300} skipDelayDuration={100}>
            {children}
          </TooltipProvider>
        </LayoutProvider>
      </ThemeProvider>
    </DesktopStoreProvider>
  );
}
