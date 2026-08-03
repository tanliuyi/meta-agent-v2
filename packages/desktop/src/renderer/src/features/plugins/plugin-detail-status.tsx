import type {
  InstalledMarketplacePluginSummary,
  MarketplacePluginSummary,
} from "../../../../shared/plugin-marketplace-contracts.ts";
import { cardState, statusLabel, statusTone } from "./plugin-marketplace-utils.ts";

export function PluginDetailStatusBadges({
  plugin,
  installed,
}: {
  plugin?: MarketplacePluginSummary;
  installed?: InstalledMarketplacePluginSummary;
}) {
  if (!plugin && !installed) return null;
  const state = cardState(plugin, installed);
  return (
    <span className="plugin-marketplace-detail-badges plugin-marketplace-detail-status-inline" aria-label="插件状态">
      <span className="plugin-marketplace-badge" data-tone={state.tone}>
        {state.label}
      </span>
      {plugin?.status && plugin.status !== "available" ? (
        <span className="plugin-marketplace-badge" data-tone={statusTone(plugin.status)}>
          {statusLabel(plugin.status)}
        </span>
      ) : null}
      {plugin?.containsNativeCode || installed?.containsNativeCode ? (
        <span className="plugin-marketplace-native-badge">包含 Native 内容</span>
      ) : null}
    </span>
  );
}
