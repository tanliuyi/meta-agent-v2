import { useDesktopSelector } from "../../state/desktop-context.tsx";
import {
  selectActivePanel,
  selectActivePanelOpen,
  selectActivePanelWidth,
  selectHasActiveControl,
} from "../../state/desktop-selectors.ts";
import { OpenWorkbenchPanel } from "./open-workbench-panel.tsx";
import { normalizeWorkbenchPanel } from "./panel-model.ts";

/** 与当前 session 绑定的可停靠 Workbench Panel。 */
export function WorkbenchPanel() {
  const hasControl = useDesktopSelector(selectHasActiveControl);
  const panelOpen = useDesktopSelector(selectActivePanelOpen);
  const panelWidth = useDesktopSelector(selectActivePanelWidth);
  const panel = useDesktopSelector(selectActivePanel);
  if (!hasControl || !panelOpen || panelWidth === null) return null;
  return <OpenWorkbenchPanel width={panelWidth} panel={normalizeWorkbenchPanel(panel)} />;
}
