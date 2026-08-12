import { Button } from "@renderer/shared/ui/button";
import { Toast } from "@renderer/shared/ui/toast";
import { useDesktopSelector } from "@renderer/state/desktop-context";
import { selectProjects } from "@renderer/state/desktop-selectors";
import { useNavigate } from "@tanstack/react-router";
import BadgeCheck from "lucide-react/dist/esm/icons/badge-check.mjs";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.mjs";
import Settings2 from "lucide-react/dist/esm/icons/settings-2.mjs";
import { useEffect, useState } from "react";
import { PluginIcon } from "../../components/chat/plugin-icon.tsx";
import { SidebarToggle } from "../../components/layout/sidebar-toggle.tsx";
import { MarketplaceSettingsDialog } from "./marketplace-settings-dialog.tsx";
import { PluginDetailActions } from "./plugin-detail-actions.tsx";
import { PluginDetailBackLink } from "./plugin-detail-back-link.tsx";
import { PluginDetailContent } from "./plugin-detail-content.tsx";
import { PluginDetailStatusBadges } from "./plugin-detail-status.tsx";
import { PluginMarketplaceBreadcrumb } from "./plugin-marketplace-breadcrumb.tsx";
import { localPluginIdOverrides } from "./plugin-marketplace-utils.ts";
import { useLocalPlugins } from "./use-local-plugins.ts";
import {
  loadMarketplacePluginDetail,
  type MarketplacePluginDetailLookup,
  resolveMarketplaceDetailPlugin,
  usePluginMarketplace,
} from "./use-plugin-marketplace.ts";

export function PluginMarketplaceDetailPage({
  pluginId,
  initialQuery = "",
}: {
  pluginId: string;
  initialQuery?: string;
}) {
  const navigate = useNavigate();
  const controller = usePluginMarketplace(true, initialQuery);
  const projects = useDesktopSelector(selectProjects);
  const localController = useLocalPlugins();
  const localOverrides = localPluginIdOverrides(
    (localController.snapshot?.entries ?? []).filter((entry) => entry.source === "development"),
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [removingOrphaned, setRemovingOrphaned] = useState(false);
  const [detailLookup, setDetailLookup] = useState<MarketplacePluginDetailLookup>();
  const [detailReloadKey, setDetailReloadKey] = useState(0);
  const pagePlugin = controller.page?.plugins.find((entry) => entry.id === pluginId);
  const activeDetailLookup = detailLookup?.pluginId === pluginId ? detailLookup : undefined;
  const plugin = resolveMarketplaceDetailPlugin(controller.page, pluginId, detailLookup);
  const installed = controller.installed?.plugins.find((entry) => entry.id === pluginId);
  const name = plugin?.name ?? installed?.displayName ?? pluginId;
  const detailStatus = pagePlugin ? "found" : (activeDetailLookup?.status ?? "loading");
  const mutationPending =
    controller.installingId !== undefined ||
    controller.updatingId !== undefined ||
    controller.uninstallingId !== undefined ||
    controller.settingEnabledId !== undefined ||
    controller.settingScopeId !== undefined;

  const refreshDetail = () => {
    setDetailLookup({ pluginId, status: "loading" });
    setDetailReloadKey((key) => key + 1);
    return controller.refresh();
  };

  useEffect(() => {
    setRemovingOrphaned(false);
  }, [pluginId]);

  // 列表页只返回 limit 内的条目；详情按 pluginId 直达查询，不依赖当前列表页命中。
  useEffect(() => {
    if (pagePlugin) return;
    let cancelled = false;
    setDetailLookup({ pluginId, status: "loading" });
    void loadMarketplacePluginDetail(pluginId, (id) => window.desktop.marketplace.getPlugin(id)).then((lookup) => {
      if (!cancelled) setDetailLookup(lookup);
    });
    return () => {
      cancelled = true;
    };
  }, [detailReloadKey, pagePlugin, pluginId]);

  useEffect(() => {
    if (
      !removingOrphaned ||
      controller.loading ||
      controller.error ||
      plugin ||
      installed ||
      activeDetailLookup?.status !== "missing"
    ) {
      return;
    }
    void navigate({
      to: "/plugins",
      search: (previous) => ({ ...previous, query: undefined, view: "marketplace" }),
      replace: true,
    });
  }, [activeDetailLookup?.status, controller.error, controller.loading, installed, navigate, plugin, removingOrphaned]);

  return (
    <>
      <header className="topbar plugin-marketplace-topbar plugin-marketplace-detail-topbar">
        <SidebarToggle location="topbar" />
        <PluginMarketplaceBreadcrumb source="marketplace" currentLabel={name} />
        <div className="topbar-actions">
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            disabled={controller.loading}
            aria-label="刷新插件目录"
            title="刷新"
            onClick={() => void refreshDetail()}
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
        <main className="plugin-marketplace-content plugin-marketplace-detail-page-content">
          <PluginDetailBackLink source="marketplace" />
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
          {plugin || installed ? (
            <div className="plugin-marketplace-detail-page">
              <header className="plugin-marketplace-detail-header plugin-marketplace-detail-page-header">
                <div className="plugin-marketplace-detail-header-main">
                  <div className="plugin-marketplace-detail-identity">
                    <div className="plugin-marketplace-detail-icon" aria-hidden="true">
                      <PluginIcon name={name} iconUrl={plugin?.iconUrl} className="size-11" />
                    </div>
                    <div>
                      <h1>{name}</h1>
                      <div className="plugin-marketplace-detail-publisher">
                        <span>{plugin?.publisher.displayName ?? installed!.marketplaceId}</span>
                        {plugin?.publisher.verified ? (
                          <span className="plugin-marketplace-verified">
                            <BadgeCheck aria-hidden="true" />
                            已验证
                          </span>
                        ) : null}
                        <PluginDetailStatusBadges plugin={plugin} installed={installed} />
                      </div>
                    </div>
                  </div>
                  <PluginDetailActions
                    plugin={plugin}
                    installed={installed}
                    mutationPending={mutationPending}
                    installing={controller.installingId === pluginId}
                    updating={controller.updatingId === pluginId}
                    uninstalling={controller.uninstallingId === pluginId}
                    onInstall={(entry) => void controller.install(entry)}
                    onUpdate={(entry) => void controller.update(entry)}
                    onUninstall={(id) => {
                      if (!plugin) setRemovingOrphaned(true);
                      void controller.uninstall(id);
                    }}
                    placement="header"
                  />
                </div>
                <p>{plugin?.description ?? "该插件已安装，但当前市场目录中没有对应条目。"}</p>
              </header>
              <PluginDetailContent
                plugin={plugin}
                installed={installed}
                marketplaceId={controller.page?.marketplaceId}
                projects={projects}
                mutationPending={mutationPending}
                supersededByLocalPlugin={installed ? localOverrides.get(installed.id) : undefined}
                onSetEnabled={(id, enabled) => void controller.setEnabled(id, enabled)}
                onSetScope={(id, scope, projectIds) => void controller.setScope(id, scope, projectIds)}
              />
            </div>
          ) : detailStatus === "loading" || controller.loading ? (
            <div className="plugin-marketplace-empty" role="status">
              正在载入插件详情
            </div>
          ) : detailStatus === "error" ? (
            <div className="plugin-marketplace-empty" role="alert">
              无法载入插件详情
            </div>
          ) : (
            <div className="plugin-marketplace-empty" role="status">
              找不到插件“{pluginId}”
            </div>
          )}
        </main>
      </div>
      <MarketplaceSettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        onSaved={() => void refreshDetail()}
      />
    </>
  );
}
