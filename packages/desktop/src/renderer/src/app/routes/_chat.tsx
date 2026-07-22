import { createFileRoute, Outlet } from "@tanstack/react-router";
import { Sidebar } from "../../components/layout/sidebar.tsx";
import { NodeRuntimeGate } from "../../features/node-runtime/node-runtime-gate.tsx";
import { DesktopCatalogProvider } from "../../state/desktop-catalog-provider.tsx";
import { DesktopErrorToast } from "../desktop-error-toast.tsx";
import { DesktopWindowTitle } from "../desktop-window-title.tsx";

export const Route = createFileRoute("/_chat")({ component: ChatLayout });

/** Shared shell for chat routes; the workspace element persists while the leaf outlet changes. */
export function ChatLayout() {
  return (
    <>
      <DesktopWindowTitle />
      <div className="app-shell">
        <DesktopCatalogProvider>
          <NodeRuntimeGate />
          <Sidebar />
          <DesktopErrorToast />
          <section className="workspace">
            <Outlet />
          </section>
        </DesktopCatalogProvider>
      </div>
    </>
  );
}
