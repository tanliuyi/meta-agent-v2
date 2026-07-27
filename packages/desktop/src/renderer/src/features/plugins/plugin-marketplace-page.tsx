import * as Tabs from "@radix-ui/react-tabs";
import { Button } from "@renderer/shared/ui/button";
import { Input } from "@renderer/shared/ui/input";
import { Toast } from "@renderer/shared/ui/toast";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.mjs";
import Search from "lucide-react/dist/esm/icons/search.mjs";
import Settings2 from "lucide-react/dist/esm/icons/settings-2.mjs";
import { useState } from "react";
import { LocalPluginsView } from "./local-plugins-view.tsx";
import { MarketplaceSettingsDialog } from "./marketplace-settings-dialog.tsx";
import { PluginDetailDialog } from "./plugin-detail-dialog.tsx";
import { MarketplacePluginCard } from "./plugin-marketplace-card.tsx";
import { useLocalPlugins } from "./use-local-plugins.ts";
import { usePluginMarketplace } from "./use-plugin-marketplace.ts";

export function PluginMarketplacePage({ returnSession }: { returnSession?: { projectId: string; threadId: string } }) {
  const [activeView, setActiveView] = useState<"marketplace" | "local">("marketplace");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const controller = usePluginMarketplace(activeView === "marketplace");
  const localController = useLocalPlugins(returnSession?.projectId, returnSession?.threadId);
  const [selectedPluginId, setSelectedPluginId] = useState<string>();
  const selectedPlugin = controller.page?.plugins.find((plugin) => plugin.id === selectedPluginId);
  const selectedInstalled = controller.installed?.plugins.find((plugin) => plugin.id === selectedPluginId);
  const orphanedInstalled = controller.installed?.plugins.filter(
    (installed) => !controller.page?.plugins.some((plugin) => plugin.id === installed.id),
  );
  const mutationPending =
    controller.installingId !== undefined ||
    controller.updatingId !== undefined ||
    controller.uninstallingId !== undefined;

  return (
    <>
      <header className="topbar plugin-marketplace-topbar">
        <h1>插件中心</h1>
        <div className="topbar-actions">
          <Button
            variant="ghost"
            size="icon"
            disabled={
              activeView === "marketplace" ? controller.loading : localController.loading || localController.mutating
            }
            aria-label={activeView === "marketplace" ? "刷新插件目录" : "刷新本地插件"}
            title="刷新"
            onClick={() => void (activeView === "marketplace" ? controller.refresh() : localController.reload())}
          >
            <RefreshCw />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="插件中心设置"
            title="设置"
            onClick={() => setSettingsOpen(true)}
          >
            <Settings2 />
          </Button>
        </div>
      </header>
      <div className="plugin-marketplace-scroll">
        <main className="plugin-marketplace-content">
          <Tabs.Root
            value={activeView}
            onValueChange={(value) => {
              if (value !== "marketplace" && value !== "local") return;
              setActiveView(value);
              setSelectedPluginId(undefined);
            }}
          >
            <Tabs.List className="plugin-center-tabs" aria-label="插件来源">
              <Tabs.Trigger value="marketplace">市场</Tabs.Trigger>
              <Tabs.Trigger value="local">本地</Tabs.Trigger>
            </Tabs.List>
            <Tabs.Content value="marketplace" className="plugin-center-tab-content">
              <header className="plugin-marketplace-page-heading">
                <h2>插件</h2>
                <span>安装、更新和管理标准 Pi Extension。</span>
              </header>
              <div className="plugin-marketplace-toolbar" data-has-options={returnSession ? "true" : undefined}>
                <div className="plugin-marketplace-search-field">
                  <Search aria-hidden="true" />
                  <Input
                    type="search"
                    value={controller.query}
                    aria-label="搜索插件"
                    placeholder="搜索插件"
                    style={{ paddingLeft: "2.25rem" }}
                    onChange={(event) => controller.setQuery(event.currentTarget.value)}
                  />
                </div>
              </div>
              {controller.page?.stale ? (
                <div className="plugin-marketplace-notice" data-tone="warning" role="status">
                  当前显示离线缓存
                </div>
              ) : null}
              {controller.installed?.revocationChecks?.some((check) => check.status !== "fresh") ? (
                <div className="plugin-marketplace-notice" data-tone="warning" role="status">
                  插件撤回状态尚未刷新，安装和更新前将先进行在线验证
                </div>
              ) : null}
              {controller.notice ? (
                <Toast
                  open
                  message={controller.notice}
                  tone="success"
                  title="插件状态已更新"
                  onDismiss={controller.clearNotice}
                />
              ) : null}
              {controller.error ? (
                <Toast
                  open
                  message={controller.error}
                  tone="error"
                  title="插件操作失败"
                  action={
                    controller.error.includes("not configured") || controller.error.includes("未配置")
                      ? {
                          label: "打开设置",
                          altText: "打开插件中心设置",
                          onClick: () => setSettingsOpen(true),
                        }
                      : undefined
                  }
                  onDismiss={controller.clearError}
                />
              ) : null}

              {orphanedInstalled && orphanedInstalled.length > 0 ? (
                <section className="plugin-marketplace-section" aria-labelledby="installed-plugin-heading">
                  <div className="plugin-marketplace-section-heading">
                    <h3 id="installed-plugin-heading">已安装</h3>
                    <span>当前市场目录中不可用的已安装插件</span>
                  </div>
                  <div className="plugin-marketplace-grid">
                    {orphanedInstalled.map((installed) => (
                      <MarketplacePluginCard
                        key={installed.id}
                        installed={installed}
                        onOpen={() => setSelectedPluginId(installed.id)}
                      />
                    ))}
                  </div>
                </section>
              ) : null}

              <section
                className="plugin-marketplace-section"
                aria-labelledby="plugin-catalog-heading"
                aria-busy={controller.loading}
              >
                <div className="plugin-marketplace-section-heading">
                  <h3 id="plugin-catalog-heading">插件目录</h3>
                  {controller.page ? <span>{controller.page.plugins.length} 个插件</span> : null}
                </div>
                {controller.page?.plugins.length ? (
                  <div className="plugin-marketplace-grid">
                    {controller.page.plugins.map((plugin) => (
                      <MarketplacePluginCard
                        key={plugin.id}
                        plugin={plugin}
                        installed={controller.installed?.plugins.find((installed) => installed.id === plugin.id)}
                        onOpen={() => setSelectedPluginId(plugin.id)}
                      />
                    ))}
                  </div>
                ) : null}
                {!controller.loading && !controller.error && controller.page?.plugins.length === 0 ? (
                  <div className="plugin-marketplace-empty">没有匹配的插件</div>
                ) : null}
                {controller.loading && !controller.page ? (
                  <div className="plugin-marketplace-empty" role="status">
                    正在载入插件目录
                  </div>
                ) : null}
              </section>
            </Tabs.Content>
            <Tabs.Content value="local" className="plugin-center-tab-content">
              <LocalPluginsView controller={localController} />
            </Tabs.Content>
          </Tabs.Root>
        </main>
      </div>
      <MarketplaceSettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        onSaved={() => void controller.refresh()}
      />
      <PluginDetailDialog
        key={selectedPluginId ?? "closed"}
        plugin={selectedPlugin}
        installed={selectedInstalled}
        marketplaceId={controller.page?.marketplaceId}
        open={selectedPluginId !== undefined && (selectedPlugin !== undefined || selectedInstalled !== undefined)}
        mutationPending={mutationPending}
        installing={controller.installingId === selectedPluginId}
        updating={controller.updatingId === selectedPluginId}
        uninstalling={controller.uninstallingId === selectedPluginId}
        onClose={() => setSelectedPluginId(undefined)}
        onInstall={(plugin) => void controller.install(plugin)}
        onUpdate={(plugin) => void controller.update(plugin)}
        onUninstall={(id) => void controller.uninstall(id)}
      />
    </>
  );
}
