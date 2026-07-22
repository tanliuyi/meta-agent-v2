import { useSessionControl, useSessionScope, useSessionWorkbench } from "../session-context.tsx";
import { OpenBottomTerminal } from "./open-bottom-terminal.tsx";

/** Bottom terminal identity and layout state persist in the cached session activity. */
export function BottomTerminal() {
  const { record } = useSessionScope();
  const control = useSessionControl();
  const workbench = useSessionWorkbench();
  if (!control || !workbench?.terminalOpen) return null;
  return <OpenBottomTerminal height={workbench.terminalHeight} name={control.cwd || record.identity.projectId} />;
}
