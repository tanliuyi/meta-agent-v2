import type { ReactNode } from "react";
import type { DesktopExtensionListEntry } from "../../../../shared/desktop-extension-contracts.ts";
import { ExtensionRow } from "./extension-row.tsx";

interface ExtensionSectionProps {
  title: string;
  entries: DesktopExtensionListEntry[];
  loading: boolean;
  empty?: string;
  renderAction?(entry: DesktopExtensionListEntry): ReactNode;
}

export function ExtensionSection({ title, entries, loading, empty, renderAction }: ExtensionSectionProps) {
  const headingId = `${title.toLowerCase()}-extensions-heading`;
  return (
    <section className="settings-section" aria-labelledby={headingId}>
      <div className="settings-section-heading">
        <h3 id={headingId}>{title}</h3>
      </div>
      <div className="extensions-list">
        {entries.map((entry) => (
          <ExtensionRow key={entry.id} entry={entry} action={renderAction?.(entry)} />
        ))}
        {entries.length === 0 && !loading ? <div className="extensions-empty">{empty ?? "没有扩展。"}</div> : null}
      </div>
    </section>
  );
}
