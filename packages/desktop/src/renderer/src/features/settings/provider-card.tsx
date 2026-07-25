import Settings2 from "lucide-react/dist/esm/icons/settings-2.mjs";
import type { ProviderEntry } from "../../../../shared/providers-config-contracts.ts";

interface ProviderCardProps {
  entry: ProviderEntry;
  onEdit(): void;
}

/** A single provider row in the unified provider list. */
export function ProviderCard({ entry, onEdit }: ProviderCardProps) {
  const sourceLabel =
    entry.source === "ai-builtin" ? "内置" : entry.source === "desktop-builtin" ? "内置(desktop)" : "自定义";
  const credLabel =
    entry.credentialStatus === "configured"
      ? "凭据已配置"
      : entry.credentialStatus === "env-available"
        ? "环境变量可用"
        : "未配置凭据";
  const modelLabel =
    entry.builtInModelCount > 0 ? `${entry.builtInModelCount}+ 内置模型` : `${entry.models.length} 个自定义模型`;

  return (
    <button type="button" className="providers-row" onClick={onEdit}>
      <div className="providers-row-avatar">{entry.displayName.charAt(0).toUpperCase()}</div>
      <div className="providers-row-body">
        <div className="providers-row-heading">
          <span className="providers-row-name">{entry.displayName}</span>
          <span className={`providers-source-badge providers-source-badge--${entry.source}`}>{sourceLabel}</span>
        </div>
        <div className="providers-row-meta">
          <span>{entry.key}</span>
          <span className="providers-row-sep">·</span>
          <span>{credLabel}</span>
          <span className="providers-row-sep">·</span>
          <span>{modelLabel}</span>
        </div>
      </div>
      <Settings2 className="providers-row-action" />
    </button>
  );
}
