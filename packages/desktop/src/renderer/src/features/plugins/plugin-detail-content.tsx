import { Switch } from "@renderer/shared/ui/switch";
import { Tabs } from "@renderer/shared/ui/tabs";
import { TabsContent } from "@renderer/shared/ui/tabs-content";
import { TabsList } from "@renderer/shared/ui/tabs-list";
import { TabsTrigger } from "@renderer/shared/ui/tabs-trigger";
import type {
  InstalledMarketplacePluginSummary,
  MarketplacePluginSummary,
} from "../../../../shared/plugin-marketplace-contracts.ts";
import { PluginConfigurationForm } from "./plugin-configuration-form.tsx";
import { formatDate } from "./plugin-marketplace-utils.ts";

export { pluginActionConfirmation } from "./plugin-detail-actions.tsx";

interface PluginDetailContentProps {
  plugin?: MarketplacePluginSummary;
  installed?: InstalledMarketplacePluginSummary;
  marketplaceId?: string;
  mutationPending: boolean;
  /** 覆盖该市场插件的本地插件显示名；存在时市场版本被禁用。 */
  supersededByLocalPlugin?: string;
  onSetEnabled(id: string, enabled: boolean): void;
}

/** Detail content shared by the route page and the legacy dialog wrapper. */
export function PluginDetailContent({
  plugin,
  installed,
  marketplaceId,
  mutationPending,
  supersededByLocalPlugin,
  onSetEnabled,
}: PluginDetailContentProps) {
  if (!plugin && !installed) return null;
  const capabilities = plugin?.capabilities ?? installed?.capabilities ?? [];

  return (
    <>
      <Tabs defaultValue="overview" className="plugin-marketplace-detail-tabs">
        <TabsList className="plugin-marketplace-detail-tab-list" aria-label="插件详情">
          <TabsTrigger value="overview">基本信息</TabsTrigger>
          <TabsTrigger value="configuration">配置</TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="plugin-marketplace-detail-tab-content">
          <div className="plugin-marketplace-detail-body">
            <section className="plugin-marketplace-detail-section" aria-labelledby="plugin-detail-versions">
              <h3 id="plugin-detail-versions">版本与来源</h3>
              <dl className="plugin-marketplace-detail-metadata">
                {installed ? (
                  <div>
                    <dt>已安装版本</dt>
                    <dd>{installed.version}</dd>
                  </div>
                ) : null}
                {plugin?.compatibleVersion ? (
                  <div>
                    <dt>兼容版本</dt>
                    <dd>{plugin.compatibleVersion}</dd>
                  </div>
                ) : null}
                {plugin?.latestVersion ? (
                  <div>
                    <dt>最新版本</dt>
                    <dd>{plugin.latestVersion}</dd>
                  </div>
                ) : null}
                <div>
                  <dt>插件 ID</dt>
                  <dd>{plugin?.id ?? installed!.id}</dd>
                </div>
                {plugin ? (
                  <div>
                    <dt>发布者 ID</dt>
                    <dd>{plugin.publisher.id}</dd>
                  </div>
                ) : null}
                <div>
                  <dt>市场</dt>
                  <dd>{installed?.marketplaceId ?? marketplaceId ?? "当前市场"}</dd>
                </div>
                {plugin ? (
                  <div>
                    <dt>更新时间</dt>
                    <dd>{formatDate(plugin.updatedAt)}</dd>
                  </div>
                ) : installed ? (
                  <div>
                    <dt>安装时间</dt>
                    <dd>{formatDate(installed.installedAt)}</dd>
                  </div>
                ) : null}
              </dl>
            </section>

            {plugin?.categories.length ? (
              <section className="plugin-marketplace-detail-section" aria-labelledby="plugin-detail-categories">
                <h3 id="plugin-detail-categories">分类</h3>
                <div className="plugin-marketplace-detail-tags">
                  {plugin.categories.map((category) => (
                    <span key={category}>{category}</span>
                  ))}
                </div>
              </section>
            ) : null}

            <section className="plugin-marketplace-detail-section" aria-labelledby="plugin-detail-capabilities">
              <h3 id="plugin-detail-capabilities">能力与风险</h3>
              <p>市场插件以全信任方式运行，可在你的账户权限下读写文件、访问网络、读取环境变量并执行程序。</p>
              {plugin?.containsNativeCode || installed?.containsNativeCode ? (
                <p className="plugin-marketplace-native-warning">此版本包含原生代码或平台二进制。</p>
              ) : null}
              {capabilities.length ? (
                <div className="plugin-marketplace-detail-tags">
                  {capabilities.map((capability) => (
                    <span key={capability}>{capability}</span>
                  ))}
                </div>
              ) : (
                <span className="plugin-marketplace-detail-muted">未提供能力声明</span>
              )}
            </section>

            {installed ? (
              <section className="plugin-marketplace-detail-section" aria-labelledby="plugin-detail-local-state">
                <h3 id="plugin-detail-local-state">本地状态</h3>
                {supersededByLocalPlugin ? (
                  <div className="plugin-marketplace-notice" data-tone="info" role="status">
                    本地插件 <strong>{supersededByLocalPlugin}</strong> 声明了相同的插件 ID，此市场版本已禁用。
                    移除或停用本地插件后此市场版本恢复可用。
                  </div>
                ) : null}
                <dl className="plugin-marketplace-detail-metadata">
                  <div>
                    <dt>安装状态</dt>
                    <dd>{installed.state === "broken" ? "已损坏" : "正常"}</dd>
                  </div>
                  <div>
                    <dt>已启用</dt>
                    <dd>{installed.enabled ? "是" : "否"}</dd>
                  </div>
                </dl>
                <div className="plugin-local-detail-toggle">
                  <div>
                    <strong>启用此插件</strong>
                    <span>仅影响新会话；当前会话需运行 /reload 重新加载。</span>
                  </div>
                  <Switch
                    checked={installed.enabled}
                    disabled={mutationPending || installed.state === "broken" || Boolean(supersededByLocalPlugin)}
                    aria-label={`${installed.displayName} 启用状态`}
                    onCheckedChange={(enabled) => onSetEnabled(installed.id, enabled)}
                  />
                </div>
              </section>
            ) : null}
          </div>
        </TabsContent>

        <TabsContent value="configuration" className="plugin-marketplace-detail-tab-content">
          <div className="plugin-marketplace-detail-body">
            {installed?.configurable ? (
              <PluginConfigurationForm pluginId={installed.id} />
            ) : (
              <section
                className="plugin-marketplace-detail-section"
                aria-labelledby="plugin-detail-configuration-empty"
              >
                <h3 id="plugin-detail-configuration-empty">配置</h3>
                <span className="plugin-marketplace-detail-muted">
                  {installed ? "该插件没有声明可配置项。" : "安装后，如果插件提供配置项，可在此管理。"}
                </span>
              </section>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </>
  );
}
