import { ChatThread } from "./chat/chat-thread.tsx";
import { Topbar } from "./layout/topbar.tsx";
import { BottomTerminal } from "./panel/bottom-terminal.tsx";
import { WorkbenchPanel } from "./panel/workbench-panel.tsx";
import { useSessionScope } from "./session-context.tsx";

/** The complete session-owned UI retained by one cache Activity. */
export function SessionSurface() {
  const { record, active } = useSessionScope();
  return (
    <section className="workspace session-surface" data-session-key={record.key} data-active={active || undefined}>
      <Topbar />
      <div className="workspace-row">
        <main className="chat-workspace">
          <ChatThread />
        </main>
        <WorkbenchPanel />
      </div>
      <BottomTerminal />
    </section>
  );
}
