import { ChatThread } from "./chat/chat-thread.tsx";
import { Topbar } from "./layout/topbar.tsx";
import { BottomTerminal } from "./panel/bottom-terminal.tsx";
import { WorkbenchPanel } from "./panel/workbench-panel.tsx";
import { useSessionScope } from "./session-context.tsx";

/** The complete UI for the currently mounted session. */
export function SessionSurface() {
  const { record, active } = useSessionScope();
  return (
    <>
      <Topbar />
      <div className="workspace-row session-surface" data-session-key={record.key} data-active={active || undefined}>
        <main className="chat-workspace">
          <ChatThread />
        </main>
        <WorkbenchPanel />
      </div>
      <BottomTerminal />
    </>
  );
}
