import PanelRight from "lucide-react/dist/esm/icons/panel-right.mjs";
import PanelRightOpen from "lucide-react/dist/esm/icons/panel-right-open.mjs";
import TerminalSquare from "lucide-react/dist/esm/icons/square-terminal.mjs";
import { TooltipIconButton } from "../assistant-ui/tooltip-icon-button.tsx";
import { useSessionControlSelector, useSessionScope, useSessionWorkbenchSelector } from "../session-context.tsx";

/** Session-scoped workbench controls retained with the cached activity. */
export function Topbar() {
  const { updateWorkbench } = useSessionScope();
  const title = useSessionControlSelector((control) => control?.extensionHost.windowTitle ?? control?.title ?? "");
  const workbenchAvailable = useSessionWorkbenchSelector((workbench) => workbench !== null);
  const panel = useSessionWorkbenchSelector((workbench) => workbench?.panel);
  const panelOpen = useSessionWorkbenchSelector((workbench) => workbench?.panelOpen ?? false);
  const terminalOpen = useSessionWorkbenchSelector((workbench) => workbench?.terminalOpen ?? false);
  return (
    <header className="topbar">
      <div className="topbar-title">
        <strong>{title}</strong>
      </div>
      {/* 暂时隐藏 */}
      {/* <div className="topbar-actions">
        <TooltipIconButton
          variant="ghost"
          size="icon"
          aria-label={terminalOpen ? "隐藏底部终端" : "显示底部终端"}
          tooltip="显示/隐藏终端"
          side="bottom"
          aria-pressed={terminalOpen}
          disabled={!workbenchAvailable}
          onClick={() => updateWorkbench({ terminalOpen: !terminalOpen })}
        >
          <TerminalSquare size={15} />
        </TooltipIconButton>
        <TooltipIconButton
          variant={panelOpen ? "outline" : "ghost"}
          size="icon"
          aria-label={panelOpen ? "隐藏右侧 Panel" : "显示右侧 Panel"}
          tooltip="显示/隐藏侧边栏"
          side="bottom"
          aria-pressed={panelOpen}
          disabled={!workbenchAvailable}
          onClick={() =>
            updateWorkbench({
              panelOpen: !panelOpen,
              panel: panel === "chat" ? "files" : (panel ?? "files"),
            })
          }
        >
          {panelOpen ? <PanelRightOpen size={15} /> : <PanelRight size={15} />}
        </TooltipIconButton>
      </div> */}
    </header>
  );
}
