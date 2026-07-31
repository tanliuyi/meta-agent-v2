import { TooltipProvider } from "@renderer/shared/ui/tooltip-provider";
import { DesktopCacheProviders } from "@renderer/state/desktop-cache-providers";
import { DesktopStoreProvider } from "@renderer/state/desktop-store-context";
import { FontProvider } from "@renderer/state/font";
import { LayoutProvider } from "@renderer/state/layout";
import { SidebarSessionProvider } from "@renderer/state/sidebar-session-context";
import { ThemeProvider } from "@renderer/state/theme";
import { ThinkingVisibilityProvider } from "@renderer/state/thinking-visibility";
import type { ReactNode } from "react";

/**
 * 注入所有路由共享的 UI provider 与 session cache 基础设施。
 *
 * SessionCacheProvider 与 TransportProvider 位于 Router 外部，
 * 确保 route 切换不销毁已缓存的 session records。
 */
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <DesktopStoreProvider>
      <ThemeProvider>
        <FontProvider>
          <ThinkingVisibilityProvider>
            <LayoutProvider>
              <SidebarSessionProvider>
                <TooltipProvider delayDuration={300} skipDelayDuration={100}>
                  <DesktopCacheProviders>{children}</DesktopCacheProviders>
                </TooltipProvider>
              </SidebarSessionProvider>
            </LayoutProvider>
          </ThinkingVisibilityProvider>
        </FontProvider>
      </ThemeProvider>
    </DesktopStoreProvider>
  );
}
