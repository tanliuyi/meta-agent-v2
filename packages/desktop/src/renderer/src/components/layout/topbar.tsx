import Info from "lucide-react/dist/esm/icons/info.mjs";
import { TooltipIconButton } from "../assistant-ui/tooltip-icon-button.tsx";
import { useSessionControlSelector, useSessionWorkbenchSelector } from "../session-context.tsx";
import { SidebarToggle } from "./sidebar-toggle.tsx";
import { WorkbenchControls } from "./workbench-controls.tsx";

/** Session-scoped workbench controls retained with the cached activity. */
export function Topbar({
  sessionInfoOpen,
  onToggleSessionInfo,
}: {
  sessionInfoOpen: boolean;
  onToggleSessionInfo(): void;
}) {
  const title = useSessionControlSelector((control) => control?.extensionHost.windowTitle ?? control?.title ?? "");
  const workbenchAvailable = useSessionWorkbenchSelector((workbench) => workbench !== null);
  return (
    <header className="topbar">
      <SidebarToggle location="topbar" />
      <div className="topbar-title">
        <strong>{title}</strong>
      </div>
      <TooltipIconButton
        variant="ghost"
        size="icon"
        aria-label={sessionInfoOpen ? "隐藏会话信息" : "显示会话信息"}
        tooltip="显示/隐藏会话信息"
        side="bottom"
        className="session-info-toggle size-6"
        aria-controls="session-info-panel"
        aria-expanded={sessionInfoOpen}
        aria-pressed={sessionInfoOpen}
        onClick={onToggleSessionInfo}
      >
        <Info className="size-4!" />
      </TooltipIconButton>
      <div className="topbar-actions">
        <WorkbenchControls disabled={!workbenchAvailable} />
      </div>
    </header>
  );
}
