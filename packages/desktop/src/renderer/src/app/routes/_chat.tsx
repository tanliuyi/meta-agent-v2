import { createFileRoute, Outlet } from "@tanstack/react-router";
import { FloatingSidebar } from "../../components/layout/floating-sidebar.tsx";
import { Sidebar } from "../../components/layout/sidebar.tsx";
import { ThreadSidebarDropZone } from "../../components/layout/thread-sidebar-drop-zone.tsx";
import { ShellRuntimeGate } from "../../features/shell-runtime/shell-runtime-gate.tsx";
import { ToastProvider } from "../../shared/ui/toast-provider.tsx";
import { DesktopCatalogProvider } from "../../state/desktop-catalog-provider.tsx";
import { ThreadDragProvider } from "../../state/thread-drag-context.tsx";
import { DesktopErrorToast } from "../desktop-error-toast.tsx";
import { DesktopWindowTitle } from "../desktop-window-title.tsx";

export const Route = createFileRoute("/_chat")({ component: ChatLayout });

/** Shared shell for chat routes; the workspace element persists while the leaf outlet changes. */
export function ChatLayout() {
  return (
    <ToastProvider label="Meta Agent 通知" swipeDirection="right">
      <DesktopWindowTitle />
      <div className="app-shell">
        <DesktopCatalogProvider>
          <ShellRuntimeGate />
          <ThreadDragProvider>
            <Sidebar />
            <FloatingSidebar />
            <DesktopErrorToast />
            <section className="workspace">
              <Outlet />
              <ThreadSidebarDropZone />
            </section>
          </ThreadDragProvider>
        </DesktopCatalogProvider>
      </div>
    </ToastProvider>
  );
}
