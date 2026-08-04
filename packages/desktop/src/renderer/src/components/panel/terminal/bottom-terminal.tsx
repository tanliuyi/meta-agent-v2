import { useSessionWorkbenchSelector, useWorkbenchAccessible } from "../../session-context.tsx";
import { OpenBottomTerminal } from "./open-bottom-terminal.tsx";

/** Bottom terminal layout state persists in the cached session activity. */
export function BottomTerminal() {
  const accessible = useWorkbenchAccessible();
  const terminalOpen = useSessionWorkbenchSelector((workbench) => workbench?.terminalOpen === true);
  const terminalHeight = useSessionWorkbenchSelector((workbench) => workbench?.terminalHeight ?? 0);
  // 收起不卸载，经 data-collapsed 驱动高度过渡动画（同 workbench-panel）。
  if (!accessible) return null;
  return <OpenBottomTerminal open={terminalOpen} height={terminalHeight} />;
}
