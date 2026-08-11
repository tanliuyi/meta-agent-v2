import { createRootRoute, Navigate, Outlet } from "@tanstack/react-router";
import { ToastProvider } from "../../shared/ui/toast-provider.tsx";
import { DesktopCatalogProvider } from "../../state/desktop-catalog-provider.tsx";
import { KeyboardShortcutProvider } from "../../state/keyboard-shortcut-provider.tsx";
import { DesktopErrorToast } from "../desktop-error-toast.tsx";

export const Route = createRootRoute({
  component: RootLayout,
  notFoundComponent: () => <Navigate to="/" replace />,
});

/** Route-agnostic window boundary. Route layouts own their navigation and content. */
function RootLayout() {
  return (
    <div className="app-frame" data-platform={window.desktop.platform}>
      <ToastProvider label="通知" swipeDirection="right">
        <DesktopCatalogProvider>
          <KeyboardShortcutProvider>
            <DesktopErrorToast />
            <Outlet />
          </KeyboardShortcutProvider>
        </DesktopCatalogProvider>
      </ToastProvider>
    </div>
  );
}
