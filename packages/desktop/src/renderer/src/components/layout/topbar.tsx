import { useSessionControlSelector, useSessionWorkbenchSelector } from "../session-context.tsx";
import { SidebarToggle } from "./sidebar-toggle.tsx";
import { WorkbenchControls } from "./workbench-controls.tsx";

/** Session-scoped workbench controls retained with the cached activity. */
export function Topbar() {
  const title = useSessionControlSelector((control) => control?.extensionHost.windowTitle ?? control?.title ?? "");
  const workbenchAvailable = useSessionWorkbenchSelector((workbench) => workbench !== null);
  return (
    <header className="topbar">
      <SidebarToggle location="topbar" />
      <div className="topbar-title">
        <strong>{title}</strong>
      </div>
      <div className="topbar-actions">
        <WorkbenchControls disabled={!workbenchAvailable} />
      </div>
    </header>
  );
}
