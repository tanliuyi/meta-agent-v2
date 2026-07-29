import Settings2 from "lucide-react/dist/esm/icons/settings-2.mjs";
import { memo } from "react";
import type { ProviderEntry } from "../../../../shared/providers-config-contracts.ts";

interface ProviderCardProps {
  entry: ProviderEntry;
  onEdit(key: string): void;
}

/** A single provider row in the unified provider list. */
export const ProviderCard = memo(function ProviderCard({ entry, onEdit }: ProviderCardProps) {
  const credLabel =
    entry.credentialStatus === "configured"
      ? "凭据已配置"
      : entry.credentialStatus === "env-available"
        ? "环境变量可用"
        : "未配置凭据";
  const modelLabel =
    entry.builtInModelCount > 0
      ? `${entry.builtInModelCount} 个内置模型`
      : entry.source === "ai-builtin"
        ? "动态模型目录"
        : `${entry.models.length} 个自定义模型`;

  return (
    <button type="button" className="providers-row" onClick={() => onEdit(entry.key)}>
      <div className="providers-row-avatar">{entry.displayName.charAt(0).toUpperCase()}</div>
      <div className="providers-row-body">
        <div className="providers-row-heading">
          <span className="providers-row-name">{entry.displayName}</span>
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
});
