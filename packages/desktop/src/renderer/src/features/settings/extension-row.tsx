import type { ReactNode } from "react";
import type { DesktopExtensionListEntry } from "../../../../shared/desktop-extension-contracts.ts";

export function ExtensionRow({ entry, action }: { entry: DesktopExtensionListEntry; action?: ReactNode }) {
  return (
    <div className="extensions-row">
      <div className="extensions-row-main">
        <div className="extensions-row-title">
          <strong>{entry.displayName}</strong>
          <span data-source={entry.source}>{sourceLabel(entry.source)}</span>
        </div>
        <span className="extensions-row-meta">{entry.displayPath ?? entry.capabilities.join(" · ")}</span>
      </div>
      {action}
    </div>
  );
}

function sourceLabel(source: DesktopExtensionListEntry["source"]): string {
  if (source === "builtin") return "Built-in";
  if (source === "curated") return "Curated";
  return "Development";
}
