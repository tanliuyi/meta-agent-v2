import { useSessionControlSelector, useSessionWorkbenchSelector } from "../session-context.tsx";
import { OpenWorkbenchPanel } from "./open-workbench-panel.tsx";
import { normalizeWorkbenchPanel } from "./panel-model.ts";

/** Workbench state is stored with the cached session record. */
export function WorkbenchPanel() {
  const hasControl = useSessionControlSelector((control) => control !== null);
  const panelOpen = useSessionWorkbenchSelector((workbench) => workbench?.panelOpen === true);
  const panelWidth = useSessionWorkbenchSelector((workbench) => workbench?.panelWidth ?? 0);
  const panel = useSessionWorkbenchSelector((workbench) => workbench?.panel);
  if (!hasControl || !panelOpen) return null;
  return <OpenWorkbenchPanel width={panelWidth} panel={normalizeWorkbenchPanel(panel ?? null)} />;
}
