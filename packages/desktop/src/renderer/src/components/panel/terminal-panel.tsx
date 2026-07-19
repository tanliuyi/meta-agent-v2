import TerminalSquare from "lucide-react/dist/esm/icons/square-terminal.mjs";
import { Suspense } from "react";
import { useDesktopSelector } from "../../state/desktop-context.tsx";
import { selectActiveProjectCwd } from "../../state/desktop-selectors.ts";
import { LazyTerminalView } from "./lazy-terminal-view.tsx";

/** 渲染 Workbench 中与 active session 绑定的终端。 */
export function TerminalPanel() {
  const cwd = useDesktopSelector(selectActiveProjectCwd);
  return (
    <div className="terminal-panel">
      <div className="terminal-title">
        <TerminalSquare size={14} />
        <span>{cwd}</span>
      </div>
      <Suspense fallback={<div className="terminal-view" aria-busy="true" />}>
        <LazyTerminalView terminalId="panel" />
      </Suspense>
    </div>
  );
}
