import { FolderOpen, GitBranch, Minimize2, PanelRight, PanelRightOpen, TerminalSquare } from "lucide-react";
import { usePiThreadPhase } from "../../runtime/use-pi-thread-snapshot.ts";
import { useDesktop } from "../../state/desktop-context.tsx";
import { TooltipIconButton } from "../assistant-ui/tooltip-icon-button.tsx";
import { Button } from "../ui/button.tsx";

/** 当前 session 的工作台顶栏。 */
export function Topbar() {
  const { project, snapshot, workbench, compactSession, updateWorkbench } = useDesktop();
  const phase = usePiThreadPhase();
  return (
    <header className="topbar">
      <div className="topbar-title">
        <strong>{snapshot?.title ?? project?.name ?? "Meta Agent"}</strong>
      </div>
      <div className="topbar-actions">
        <Button
          variant="ghost"
          size="icon"
          aria-label="切换底部终端"
          disabled={!workbench}
          onClick={() => updateWorkbench({ terminalOpen: !workbench?.terminalOpen })}
        >
          <TerminalSquare size={15} />
        </Button>
        <Button
          variant={workbench?.panelOpen ? "outline" : "ghost"}
          size="icon"
          aria-label="切换右侧 Panel"
          disabled={!workbench}
          onClick={() =>
            updateWorkbench({
              panelOpen: !workbench?.panelOpen,
              panel: workbench?.panel === "chat" ? "files" : workbench?.panel,
            })
          }
        >
          {workbench?.panelOpen ? <PanelRight size={15} /> : <PanelRightOpen size={15} />}
        </Button>
      </div>
    </header>
  );
}
