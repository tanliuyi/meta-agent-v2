import {
  useSessionControlSelector,
  useSessionScope,
  useSessionWorkbenchSelector,
  useWorkbenchAccessible,
} from "../../session-context.tsx";
import { OpenBottomTerminal } from "./open-bottom-terminal.tsx";

/** Bottom terminal identity and layout state persist in the cached session activity. */
export function BottomTerminal() {
  const { record } = useSessionScope();
  const cwd = useSessionControlSelector((control) => control?.cwd);
  const accessible = useWorkbenchAccessible();
  const terminalOpen = useSessionWorkbenchSelector((workbench) => workbench?.terminalOpen === true);
  const terminalHeight = useSessionWorkbenchSelector((workbench) => workbench?.terminalHeight ?? 0);
  if (!accessible || !terminalOpen) return null;
  return <OpenBottomTerminal height={terminalHeight} name={cwd || record.identity.projectId} />;
}
