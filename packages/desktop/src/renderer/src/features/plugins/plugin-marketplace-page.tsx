import { Button } from "@renderer/shared/ui/button";
import { Input } from "@renderer/shared/ui/input";
import { Tabs } from "@renderer/shared/ui/tabs";
import { TabsContent } from "@renderer/shared/ui/tabs-content";
import { TabsList } from "@renderer/shared/ui/tabs-list";
import { TabsTrigger } from "@renderer/shared/ui/tabs-trigger";
import { Toast } from "@renderer/shared/ui/toast";
import { useNavigate } from "@tanstack/react-router";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.mjs";
import Search from "lucide-react/dist/esm/icons/search.mjs";
import Settings2 from "lucide-react/dist/esm/icons/settings-2.mjs";
import { useEffect, useState } from "react";
import { SidebarToggle } from "../../components/layout/sidebar-toggle.tsx";
import { LocalPluginsView } from "./local-plugins-view.tsx";
import { MarketplaceSettingsDialog } from "./marketplace-settings-dialog.tsx";
import { MarketplacePluginCard } from "./plugin-marketplace-card.tsx";
import { useLocalPlugins } from "./use-local-plugins.ts";
import { usePluginMarketplace } from "./use-plugin-marketplace.ts";

export function PluginMarketplacePage({
  returnSession,
  initialQuery = "",
  initialView = "marketplace",
}: {
  returnSession?: { projectId: string; threadId: string };
  initialQuery?: string;
  initialView?: "marketplace" | "local";
}) {
  const navigate = useNavigate();
  const [activeView, setActiveView] = useState<"marketplace" | "local">(initialView);
  const [settingsOpen, setSettingsOpen] = useState(false);
  useEffect(() => {
    setActiveView(initialView);
  }, [initialView]);
  const controller = usePluginMarketplace(activeView === "marketplace", initialQuery);
  const localController = useLocalPlugins(returnSession?.projectId, returnSession?.threadId);
  const orphanedInstalled = controller.installed?.plugins.filter(
    (installed) => !controller.page?.plugins.some((plugin) => plugin.id === installed.id),
  );

  return (
    <>
      <header className="topbar plugin-marketplace-topbar">
        <SidebarToggle location="topbar" />
        <h1>插件中心</h1>
        <div className="topbar-actions">
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
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
            className="size-6"
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
          <Tabs
            value={activeView}
            onValueChange={(value) => {
              if (value !== "marketplace" && value !== "local") return;
              setActiveView(value);
              void navigate({
                to: "/plugins",
                search: (previous) => ({
                  ...previous,
                  query: value === "marketplace" ? previous.query : undefined,
                  view: value,
                }),
              });
            }}
          >
            <TabsList className="plugin-center-tabs" aria-label="插件来源">
              <TabsTrigger value="marketplace">市场</TabsTrigger>
              <TabsTrigger value="local">本地</TabsTrigger>
            </TabsList>
            <TabsContent value="marketplace" className="plugin-center-tab-content">
              <header className="plugin-marketplace-page-heading">
                <h2>插件</h2>
                <span>安装、更新和管理标准插件。</span>
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
                    onChange={(event) => {
                      const query = event.currentTarget.value;
                      controller.setQuery(query);
                      void navigate({
                        to: "/plugins",
                        search: (previous) => ({
                          ...previous,
                          query: query || undefined,
                          view: "marketplace",
                        }),
                      });
                    }}
                  />
                </div>
              </div>
              {controller.page?.stale ? (
                <div className="plugin-marketplace-notice" data-tone="warning" role="status">
                  当前显示离线缓存
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
                        onOpen={() =>
                          void navigate({
                            to: "/plugins/$pluginId",
                            params: { pluginId: installed.id },
                            search: (previous) => ({
                              ...previous,
                              query: controller.query || undefined,
                              view: "marketplace",
                            }),
                          })
                        }
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
                        onOpen={() =>
                          void navigate({
                            to: "/plugins/$pluginId",
                            params: { pluginId: plugin.id },
                            search: (previous) => ({
                              ...previous,
                              query: controller.query || undefined,
                              view: "marketplace",
                            }),
                          })
                        }
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
            </TabsContent>
            <TabsContent value="local" className="plugin-center-tab-content">
              <LocalPluginsView
                controller={localController}
                onOpen={(pluginId) =>
                  void navigate({
                    to: "/plugins/local/$pluginId",
                    params: { pluginId },
                    search: (previous) => ({ ...previous, query: undefined, view: "local" }),
                  })
                }
              />
            </TabsContent>
          </Tabs>
        </main>
      </div>
      <MarketplaceSettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        onSaved={() => void controller.refresh()}
      />
    </>
  );
}
