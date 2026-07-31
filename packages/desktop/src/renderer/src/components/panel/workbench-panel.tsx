import { useSidebarSessions } from "../../state/sidebar-session-context.tsx";
import { useSessionControlSelector, useSessionWorkbenchSelector } from "../session-context.tsx";
import { OpenWorkbenchPanel } from "./open-workbench-panel.tsx";
import { normalizeWorkbenchPanel } from "./panel-model.ts";

/** Workbench state is stored with the cached session record. */
export function WorkbenchPanel() {
  const hasControl = useSessionControlSelector((control) => control !== null);
  const panelOpen = useSessionWorkbenchSelector((workbench) => workbench?.panelOpen === true);
  const panelWidth = useSessionWorkbenchSelector((workbench) => workbench?.panelWidth ?? 0);
  const panel = useSessionWorkbenchSelector((workbench) => workbench?.panel);
  const sidebarSessions = useSidebarSessions();
  if (!hasControl) return null;
  return (
    <OpenWorkbenchPanel
      open={panelOpen}
      width={panelWidth}
      panel={normalizeWorkbenchPanel(panel ?? null)}
      subagentTabs={sidebarSessions.tabs}
      activeSubagentKey={sidebarSessions.activeKey}
      onActivateSubagent={sidebarSessions.activate}
      onCloseSubagentTab={(tab) => sidebarSessions.closeTab(tab.key)}
      newPanel={sidebarSessions.newPanel}
      onOpenNewPanel={sidebarSessions.openNewPanel}
      onStartNewDraft={sidebarSessions.startNewDraft}
    />
  );
}
