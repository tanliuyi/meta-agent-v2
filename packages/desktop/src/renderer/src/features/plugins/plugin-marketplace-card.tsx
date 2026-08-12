import { Switch } from "@renderer/shared/ui/switch";
import BadgeCheck from "lucide-react/dist/esm/icons/badge-check.mjs";
import type {
  InstalledMarketplacePluginSummary,
  MarketplacePluginSummary,
} from "../../../../shared/plugin-marketplace-contracts.ts";
import { PluginIcon } from "../../components/chat/plugin-icon.tsx";
import { cardState } from "./plugin-marketplace-utils.ts";

interface MarketplacePluginCardProps {
  plugin?: MarketplacePluginSummary;
  installed?: InstalledMarketplacePluginSummary;
  /** 覆盖该市场插件的本地插件显示名；存在时市场版本被禁用。 */
  mutationPending?: boolean;
  supersededByLocalPlugin?: string;
  onOpen(): void;
  onToggleEnabled?(enabled: boolean): void;
}

export function MarketplacePluginCard({
  plugin,
  installed,
  mutationPending = false,
  supersededByLocalPlugin,
  onOpen,
  onToggleEnabled,
}: MarketplacePluginCardProps) {
  if (!plugin && !installed) return null;
  const name = plugin?.name ?? installed!.displayName;
  const publisher = plugin?.publisher.displayName ?? installed!.marketplaceId;
  const description = plugin?.description ?? "该插件已安装，但当前市场目录中没有对应条目。";
  const version = installed?.version ?? plugin?.compatibleVersion ?? plugin?.latestVersion;
  const state = cardState(plugin, installed, supersededByLocalPlugin);

  const canToggle = installed?.state === "installed" && !supersededByLocalPlugin && onToggleEnabled;

  return (
    <div className="plugin-marketplace-card" data-status={plugin?.status}>
      <button
        type="button"
        className="plugin-marketplace-card-main"
        aria-label={`查看 ${name} 详情`}
        title={supersededByLocalPlugin ? `已由本地插件 ${supersededByLocalPlugin} 覆盖，市场版本禁用` : undefined}
        onClick={onOpen}
      >
        <span className="plugin-marketplace-card-header">
          <span className="plugin-marketplace-card-icon" aria-hidden="true">
            <PluginIcon name={name} iconUrl={plugin?.iconUrl} className="size-10" />
          </span>
          <span className="plugin-marketplace-card-title">
            <strong>{name}</strong>
            <span>
              {publisher}
              {plugin?.publisher.verified ? <BadgeCheck aria-label="已验证发布者" /> : null}
            </span>
          </span>
          <span className="plugin-marketplace-badge" data-tone={state.tone}>
            {state.label}
          </span>
        </span>
        <span className="plugin-marketplace-card-description">{description}</span>
      </button>
      <span className="plugin-marketplace-card-footer">
        <span>{version ? `v${version}` : "无兼容版本"}</span>
        {installed ? (
          <span
            className="plugin-marketplace-scope-badge"
            title={
              installed.scope === "project"
                ? `仅以下项目的会话可加载此插件：${(installed.projectIds ?? []).join("、")}`
                : "所有项目的会话均可加载此插件"
            }
          >
            {installed.scope === "project" ? "指定项目" : "全部项目"}
          </span>
        ) : null}
        {plugin?.categories[0] ? <span>{plugin.categories[0]}</span> : null}
        {plugin?.containsNativeCode || installed?.containsNativeCode ? (
          <span className="plugin-marketplace-native-badge">Native</span>
        ) : null}
        {supersededByLocalPlugin ? (
          <span className="plugin-marketplace-scope-badge" title="本地插件已声明相同插件 ID，市场版本不会加载">
            本地覆盖
          </span>
        ) : null}
        {installed ? (
          <Switch
            checked={installed.enabled}
            disabled={!canToggle || mutationPending}
            aria-label={`${name} 启用状态`}
            title={installed.state === "broken" ? "插件已损坏，无法启用" : undefined}
            onCheckedChange={onToggleEnabled}
          />
        ) : null}
      </span>
    </div>
  );
}
