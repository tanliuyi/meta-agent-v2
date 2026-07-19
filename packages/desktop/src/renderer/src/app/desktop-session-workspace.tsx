import { ChatThread } from "@renderer/components/chat/chat-thread";
import { BottomTerminal } from "@renderer/components/panel/bottom-terminal";
import { WorkbenchPanel } from "@renderer/components/panel/workbench-panel";
import { useDesktopSelector } from "@renderer/state/desktop-context";
import { selectActiveSessionKey } from "@renderer/state/desktop-selectors";

/** 只在 active session identity 变化时重建 session-scoped Panel 和 Terminal。 */
export function DesktopSessionWorkspace() {
  const sessionKey = useDesktopSelector(selectActiveSessionKey) || "empty";
  return (
    <>
      <div className="workspace-row">
        <main className="chat-workspace">
          <ChatThread />
        </main>
        <WorkbenchPanel key={sessionKey} />
      </div>
      <BottomTerminal key={sessionKey} />
    </>
  );
}
