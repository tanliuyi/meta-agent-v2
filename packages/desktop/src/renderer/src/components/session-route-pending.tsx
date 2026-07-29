import { SessionBootstrapPendingThread } from "./chat/session-bootstrap-pending-thread.tsx";

export function SessionRoutePending() {
  return (
    <>
      <header className="topbar">
        <div className="topbar-title">
          <strong>会话</strong>
        </div>
      </header>
      <div className="workspace-row">
        <main className="chat-workspace">
          <SessionBootstrapPendingThread />
        </main>
      </div>
    </>
  );
}
