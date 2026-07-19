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
import { TooltipIconButton } from "../assistant-ui/tooltip-icon-button.tsx";

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
        <TooltipIconButton
          variant="ghost"
          size="icon"
          aria-label={terminalOpen ? "隐藏底部终端" : "显示底部终端"}
          tooltip="显示/隐藏终端"
          side="bottom"
          aria-pressed={terminalOpen}
          disabled={!hasWorkbench}
          onClick={() => actions.updateWorkbench({ terminalOpen: !terminalOpen })}
        >
          <TerminalSquare size={15} />
        </TooltipIconButton>
        <TooltipIconButton
          variant={panelOpen ? "outline" : "ghost"}
          size="icon"
          aria-label={panelOpen ? "隐藏右侧 Panel" : "显示右侧 Panel"}
          tooltip={"显示/隐藏侧边栏"}
          side="bottom"
          aria-pressed={panelOpen}
          disabled={!hasWorkbench}
          onClick={() =>
            actions.updateWorkbench({
              panelOpen: !panelOpen,
              panel: panel === "chat" ? "files" : (panel ?? "files"),
            })
          }
        >
          {/* {panelOpen ? <PanelRight size={15} /> : <PanelRightOpen size={15} />} */}
          <PanelRight size={15} />
        </TooltipIconButton>
      </div>
    </header>
  );
}
