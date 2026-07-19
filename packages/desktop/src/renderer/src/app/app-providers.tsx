import { TooltipProvider } from "@renderer/shared/ui/tooltip-provider";
import { ThemeProvider } from "@renderer/state/theme";
import type { ReactNode } from "react";

/** 注入所有路由共享的轻量 UI provider，不初始化 Desktop session runtime。 */
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider>
      <TooltipProvider delayDuration={300} skipDelayDuration={100}>
        {children}
      </TooltipProvider>
    </ThemeProvider>
  );
}
