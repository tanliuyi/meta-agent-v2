import { useDesktopSelector } from "../../state/desktop-context.tsx";
import {
  selectActiveProjectName,
  selectActiveTerminalHeight,
  selectActiveTerminalOpen,
  selectHasActiveControl,
} from "../../state/desktop-selectors.ts";
import { OpenBottomTerminal } from "./open-bottom-terminal.tsx";

/** 当前 session 独立的底部终端停靠区。 */
export function BottomTerminal() {
  const hasControl = useDesktopSelector(selectHasActiveControl);
  const terminalOpen = useDesktopSelector(selectActiveTerminalOpen);
  const terminalHeight = useDesktopSelector(selectActiveTerminalHeight);
  const projectName = useDesktopSelector(selectActiveProjectName);
  if (!hasControl || !terminalOpen || terminalHeight === null || projectName === null) return null;
  return <OpenBottomTerminal height={terminalHeight} name={projectName} />;
}
