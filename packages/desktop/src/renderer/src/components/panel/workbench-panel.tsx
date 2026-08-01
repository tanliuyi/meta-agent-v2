import { workbenchTabKey } from "../../state/workbench-tab-context.tsx";
import {
  useSessionControlSelector,
  useSessionWorkbenchSelector,
  useSessionWorkbenchTabs,
} from "../session-context.tsx";
import { OpenWorkbenchPanel } from "./open-workbench-panel.tsx";

/** Workbench state is stored with the cached session record. */
export function WorkbenchPanel() {
  const hasControl = useSessionControlSelector((control) => control !== null);
  const panelOpen = useSessionWorkbenchSelector((workbench) => workbench?.panelOpen === true);
  const panelWidth = useSessionWorkbenchSelector((workbench) => workbench?.panelWidth ?? 0);
  const tabs = useSessionWorkbenchTabs();
  if (!hasControl) return null;
  return (
    <OpenWorkbenchPanel
      open={panelOpen}
      width={panelWidth}
      tabs={tabs.tabs}
      activeKey={tabs.activeKey}
      onActivate={tabs.activate}
      onCloseTab={(tab) => tabs.closeTab(workbenchTabKey(tab))}
      onOpenNewPanel={tabs.openNewPanel}
      onOpenPanelTab={tabs.openPanelTab}
    />
  );
}
