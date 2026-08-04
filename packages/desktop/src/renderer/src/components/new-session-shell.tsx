import { type ReactNode } from "react";
import { SidebarToggle } from "./layout/sidebar-toggle.tsx";
import { WorkbenchControls } from "./layout/workbench-controls.tsx";
import { BottomTerminal } from "./panel/terminal/bottom-terminal.tsx";
import { WorkbenchPanel } from "./panel/workbench-panel.tsx";

/** 新会话页面的会话壳：topbar + 主工作区 + 底部终端 + 右侧 Panel（草稿模式复用 session-scoped 组件）。 */
export function NewSessionShell({
  disabled,
  error,
  children,
}: {
  disabled: boolean;
  error: string | null;
  children: ReactNode;
}) {
  return (
    <>
      <div className="session-surface-shell">
        <header className="topbar">
          <SidebarToggle location="topbar" />
          <div className="topbar-title">
            <strong>新会话</strong>
          </div>
          <div className="topbar-actions">
            <WorkbenchControls disabled={disabled} />
          </div>
        </header>
        <div className="workspace-row">
          <main className="chat-workspace">{children}</main>
        </div>
        {error ? <div className="composer-error">{error}</div> : null}
      </div>
      <BottomTerminal />
      <WorkbenchPanel />
    </>
  );
}
