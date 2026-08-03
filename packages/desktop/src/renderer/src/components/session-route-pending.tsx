import { SessionBootstrapPendingThread } from "./chat/session-bootstrap-pending-thread.tsx";
import { SidebarToggle } from "./layout/sidebar-toggle.tsx";

export function SessionRoutePending() {
  return (
    <div className="session-surface-shell">
      <header className="topbar">
        <SidebarToggle location="topbar" />
        <div className="topbar-title">
          <strong>会话</strong>
        </div>
      </header>
      <div className="workspace-row">
        <main className="chat-workspace">
          <SessionBootstrapPendingThread />
        </main>
      </div>
    </div>
  );
}
