import { Outlet } from "@tanstack/react-router";
import { FloatingSidebar } from "../components/layout/floating-sidebar.tsx";
import { Sidebar } from "../components/layout/sidebar.tsx";
import { ThreadSidebarDropZone } from "../components/layout/thread-sidebar-drop-zone.tsx";
import { ShellRuntimeGate } from "../features/shell-runtime/shell-runtime-gate.tsx";
import { ThreadDragProvider } from "../state/thread-drag-context.tsx";
import { DesktopWindowTitle } from "./desktop-window-title.tsx";

/** Shared shell for chat routes; the workspace element persists while the leaf outlet changes. */
export function ChatLayout() {
  return (
    <>
      <DesktopWindowTitle />
      <div className="app-shell">
        <ShellRuntimeGate />
        <ThreadDragProvider>
          <Sidebar />
          <FloatingSidebar />
          <section className="workspace">
            <Outlet />
            <ThreadSidebarDropZone />
          </section>
        </ThreadDragProvider>
      </div>
    </>
  );
}
