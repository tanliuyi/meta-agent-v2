import { Button } from "@renderer/shared/ui/button";
import { Switch } from "@renderer/shared/ui/switch";
import { Toast } from "@renderer/shared/ui/toast";
import Download from "lucide-react/dist/esm/icons/download.mjs";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.mjs";
import Trash2 from "lucide-react/dist/esm/icons/trash-2.mjs";
import { PluginIcon } from "../../components/chat/plugin-icon.tsx";
import { SidebarToggle } from "../../components/layout/sidebar-toggle.tsx";
import { PluginDetailBackLink } from "./plugin-detail-back-link.tsx";
import { PluginMarketplaceBreadcrumb } from "./plugin-marketplace-breadcrumb.tsx";
import { useCodexPlugins } from "./use-codex-plugins.ts";

export function CodexPluginDetailPage({ pluginId }: { pluginId: string }) {
  const controller = useCodexPlugins();
  const plugin = controller.snapshot?.plugins.find((entry) => entry.id === pluginId);
  return (
    <>
      <header className="topbar plugin-marketplace-topbar plugin-marketplace-detail-topbar">
        <SidebarToggle location="topbar" />
        <PluginMarketplaceBreadcrumb source="marketplace" currentLabel={plugin?.displayName ?? pluginId} />
      </header>
      <div className="plugin-marketplace-scroll">
        <main className="plugin-marketplace-content plugin-marketplace-detail-page-content">
          <PluginDetailBackLink source="marketplace" />
          {controller.notice ? (
            <Toast
              open
              title="插件状态已更新"
              message={controller.notice}
              tone="success"
              onDismiss={controller.clearNotice}
            />
          ) : null}
          {controller.error ? (
            <Toast
              open
              title="插件操作失败"
              message={controller.error}
              tone="error"
              onDismiss={controller.clearError}
            />
          ) : null}
          {plugin ? (
            <div className="plugin-marketplace-detail-page">
              <header className="plugin-marketplace-detail-header plugin-marketplace-detail-page-header">
                <div className="plugin-marketplace-detail-header-main">
                  <div className="plugin-marketplace-detail-identity">
                    <div className="plugin-marketplace-detail-icon">
                      <PluginIcon name={plugin.displayName} className="size-11" />
                    </div>
                    <div>
                      <h1>{plugin.displayName}</h1>
                      <div className="plugin-marketplace-detail-publisher">
                        <span>{plugin.developerName}</span>
                        <span className="plugin-marketplace-badge" data-tone={plugin.installed ? "success" : "neutral"}>
                          {plugin.installed ? "已安装" : "未安装"}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="plugin-marketplace-detail-actions plugin-marketplace-detail-header-actions">
                    {plugin.installed ? (
                      <>
                        <div className="plugin-marketplace-detail-enable-toggle">
                          <span>启用</span>
                          <Switch
                            aria-label={`${plugin.displayName}启用状态`}
                            checked={plugin.enabled}
                            disabled={controller.pendingId !== undefined}
                            onCheckedChange={() => void controller.mutate(plugin, "toggle")}
                          />
                        </div>
                        <Button
                          variant="outline"
                          disabled={controller.pendingId !== undefined}
                          onClick={() => void controller.mutate(plugin, "uninstall")}
                        >
                          <Trash2 />
                          卸载
                        </Button>
                        <Button
                          disabled={controller.pendingId !== undefined}
                          onClick={() => void controller.mutate(plugin, "update")}
                        >
                          <RefreshCw />
                          更新
                        </Button>
                      </>
                    ) : (
                      <Button
                        disabled={controller.pendingId !== undefined}
                        onClick={() => void controller.mutate(plugin, "install")}
                      >
                        <Download />
                        安装
                      </Button>
                    )}
                  </div>
                </div>
                <p>{plugin.description}</p>
              </header>
              <div className="plugin-marketplace-detail-body">
                <section className="plugin-marketplace-detail-section">
                  <h3>Codex manifest</h3>
                  <dl className="plugin-marketplace-detail-metadata">
                    <div>
                      <dt>插件 ID</dt>
                      <dd>{plugin.id}</dd>
                    </div>
                    <div>
                      <dt>版本</dt>
                      <dd>{plugin.version}</dd>
                    </div>
                    <div>
                      <dt>Marketplace</dt>
                      <dd>{plugin.marketplace === "personal" ? "个人 Marketplace" : "自定义 Marketplace"}</dd>
                    </div>
                    <div>
                      <dt>来源</dt>
                      <dd>本地路径</dd>
                    </div>
                    {plugin.category ? (
                      <div>
                        <dt>Manifest 分类</dt>
                        <dd>{plugin.category}</dd>
                      </div>
                    ) : null}
                    {plugin.marketplaceCategory ? (
                      <div>
                        <dt>Marketplace 分类</dt>
                        <dd>{plugin.marketplaceCategory}</dd>
                      </div>
                    ) : null}
                    {plugin.installationPolicy ? (
                      <div>
                        <dt>安装策略</dt>
                        <dd>{plugin.installationPolicy}</dd>
                      </div>
                    ) : null}
                    {plugin.authenticationPolicy ? (
                      <div>
                        <dt>认证策略</dt>
                        <dd>{plugin.authenticationPolicy}</dd>
                      </div>
                    ) : null}
                    {plugin.products.length ? (
                      <div>
                        <dt>适用产品</dt>
                        <dd>{plugin.products.join(", ")}</dd>
                      </div>
                    ) : null}
                    {plugin.license ? (
                      <div>
                        <dt>许可证</dt>
                        <dd>{plugin.license}</dd>
                      </div>
                    ) : null}
                  </dl>
                </section>
                {plugin.capabilities.length ? (
                  <section className="plugin-marketplace-detail-section">
                    <h3>功能</h3>
                    <div className="plugin-marketplace-detail-tags">
                      {plugin.capabilities.map((value) => (
                        <span key={value}>{value}</span>
                      ))}
                    </div>
                  </section>
                ) : null}
                {plugin.keywords.length ? (
                  <section className="plugin-marketplace-detail-section">
                    <h3>关键词</h3>
                    <div className="plugin-marketplace-detail-tags">
                      {plugin.keywords.map((value) => (
                        <span key={value}>{value}</span>
                      ))}
                    </div>
                  </section>
                ) : null}
              </div>
            </div>
          ) : controller.loading ? (
            <div className="plugin-marketplace-empty" role="status">
              正在载入插件详情
            </div>
          ) : (
            <div className="plugin-marketplace-empty" role="alert">
              找不到插件“{pluginId}”
            </div>
          )}
        </main>
      </div>
    </>
  );
}
