import { useSessionControlSelector, useSessionScope, useSessionWorkbenchSelector } from "../../session-context.tsx";
import { OpenBottomTerminal } from "./open-bottom-terminal.tsx";

/** Bottom terminal identity and layout state persist in the cached session activity. */
export function BottomTerminal() {
  const { record } = useSessionScope();
  const cwd = useSessionControlSelector((control) => control?.cwd);
  const hasControl = useSessionControlSelector((control) => control !== null);
  const terminalOpen = useSessionWorkbenchSelector((workbench) => workbench?.terminalOpen === true);
  const terminalHeight = useSessionWorkbenchSelector((workbench) => workbench?.terminalHeight ?? 0);
  if (!hasControl || !terminalOpen) return null;
  return <OpenBottomTerminal height={terminalHeight} name={cwd || record.identity.projectId} />;
}
