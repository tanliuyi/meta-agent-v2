export function SessionBootstrapPendingThread() {
  return (
    <div className="session-bootstrap-pending" aria-busy="true" aria-label="正在连接会话">
      <div className="session-bootstrap-messages" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <div className="session-bootstrap-composer" aria-hidden="true">
        <div className="session-bootstrap-input" />
        <div className="session-bootstrap-controls">
          <span />
          <span />
        </div>
      </div>
    </div>
  );
}
