import { useSessionControl, useSessionWorkbench } from "../session-context.tsx";
import { OpenWorkbenchPanel } from "./open-workbench-panel.tsx";
import { normalizeWorkbenchPanel } from "./panel-model.ts";

/** Workbench state is stored with the cached session record. */
export function WorkbenchPanel() {
  const control = useSessionControl();
  const workbench = useSessionWorkbench();
  if (!control || !workbench?.panelOpen) return null;
  return <OpenWorkbenchPanel width={workbench.panelWidth} panel={normalizeWorkbenchPanel(workbench.panel)} />;
}
