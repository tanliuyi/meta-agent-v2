import PanelRight from "lucide-react/dist/esm/icons/panel-right.mjs";
import TerminalSquare from "lucide-react/dist/esm/icons/square-terminal.mjs";
import { TooltipIconButton } from "../assistant-ui/tooltip-icon-button.tsx";
import { useSessionControlSelector, useSessionScope, useSessionWorkbenchSelector } from "../session-context.tsx";
import { SidebarToggle } from "./sidebar-toggle.tsx";

/** Session-scoped workbench controls retained with the cached activity. */
export function Topbar() {
  const { updateWorkbench } = useSessionScope();
  const title = useSessionControlSelector((control) => control?.extensionHost.windowTitle ?? control?.title ?? "");
  const workbenchAvailable = useSessionWorkbenchSelector((workbench) => workbench !== null);
  const panelOpen = useSessionWorkbenchSelector((workbench) => workbench?.panelOpen ?? false);
  const terminalOpen = useSessionWorkbenchSelector((workbench) => workbench?.terminalOpen ?? false);
  return (
    <header className="topbar">
      <SidebarToggle location="topbar" />
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
          className="size-6"
          aria-pressed={terminalOpen}
          disabled={!workbenchAvailable}
          onClick={() => updateWorkbench({ terminalOpen: !terminalOpen })}
        >
          <TerminalSquare className="size-4!" />
        </TooltipIconButton>
        <TooltipIconButton
          variant="ghost"
          size="icon"
          aria-label={panelOpen ? "隐藏右侧 Panel" : "显示右侧 Panel"}
          tooltip="显示/隐藏侧边栏"
          side="bottom"
          className="size-6"
          aria-pressed={panelOpen}
          disabled={!workbenchAvailable}
          onClick={() => {
            if (panelOpen) {
              updateWorkbench({ panelOpen: false });
              return;
            }
            updateWorkbench({ panelOpen: true });
          }}
        >
          <PanelRight className="panel-toggle-icon panel-toggle-icon-right size-4!" data-collapsed={!panelOpen} />
        </TooltipIconButton>
      </div>
    </header>
  );
}
