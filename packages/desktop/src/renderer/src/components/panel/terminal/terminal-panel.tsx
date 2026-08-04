import TerminalSquare from "lucide-react/dist/esm/icons/square-terminal.mjs";
import { Suspense } from "react";
import { useSessionControlSelector, useSessionScope } from "../../session-context.tsx";
import { LazyTerminalView } from "./lazy-terminal-view.tsx";

/** Workbench terminal is scoped to the cached session record. */
export function TerminalPanel() {
  const { record } = useSessionScope();
  const cwd = useSessionControlSelector((control) => control?.cwd ?? "");
  return (
    <div className="terminal-panel">
      <div className="terminal-title">
        <TerminalSquare size={14} />
        <span>{cwd || record.identity.projectId}</span>
      </div>
      <Suspense fallback={<div className="terminal-view" aria-busy="true" />}>
        <LazyTerminalView terminalId="panel" />
      </Suspense>
    </div>
  );
}
