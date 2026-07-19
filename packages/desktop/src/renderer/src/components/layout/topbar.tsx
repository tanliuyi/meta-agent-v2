import { Button } from "@renderer/shared/ui/button";
import PanelRight from "lucide-react/dist/esm/icons/panel-right.mjs";
import PanelRightOpen from "lucide-react/dist/esm/icons/panel-right-open.mjs";
import TerminalSquare from "lucide-react/dist/esm/icons/square-terminal.mjs";
import { useDesktopActions, useDesktopSelector } from "../../state/desktop-context.tsx";
import {
  selectActivePanel,
  selectActivePanelOpen,
  selectActiveTerminalOpen,
  selectHasActiveWorkbench,
  selectWindowTitle,
} from "../../state/desktop-selectors.ts";

/** 当前 session 的工作台顶栏。 */
export function Topbar() {
  const actions = useDesktopActions();
  const title = useDesktopSelector(selectWindowTitle);
  const hasWorkbench = useDesktopSelector(selectHasActiveWorkbench);
  const panel = useDesktopSelector(selectActivePanel);
  const panelOpen = useDesktopSelector(selectActivePanelOpen);
  const terminalOpen = useDesktopSelector(selectActiveTerminalOpen);
  return (
    <header className="topbar">
      <div className="topbar-title">
        <strong>{title}</strong>
      </div>
      <div className="topbar-actions">
        <Button
          variant="ghost"
          size="icon"
          aria-label={terminalOpen ? "隐藏底部终端" : "显示底部终端"}
          aria-pressed={terminalOpen}
          disabled={!hasWorkbench}
          onClick={() => actions.updateWorkbench({ terminalOpen: !terminalOpen })}
        >
          <TerminalSquare size={15} />
        </Button>
        <Button
          variant={panelOpen ? "outline" : "ghost"}
          size="icon"
          aria-label={panelOpen ? "隐藏右侧 Panel" : "显示右侧 Panel"}
          aria-pressed={panelOpen}
          disabled={!hasWorkbench}
          onClick={() =>
            actions.updateWorkbench({
              panelOpen: !panelOpen,
              panel: panel === "chat" ? "files" : (panel ?? "files"),
            })
          }
        >
          {panelOpen ? <PanelRight size={15} /> : <PanelRightOpen size={15} />}
        </Button>
      </div>
    </header>
  );
}
