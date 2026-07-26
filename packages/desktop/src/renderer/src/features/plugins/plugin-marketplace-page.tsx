import { Button } from "@renderer/shared/ui/button";
import { Checkbox } from "@renderer/shared/ui/checkbox";
import { ConfirmDialog } from "@renderer/shared/ui/confirm-dialog";
import { Input } from "@renderer/shared/ui/input";
import { Link } from "@tanstack/react-router";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.mjs";
import Search from "lucide-react/dist/esm/icons/search.mjs";
import { useState } from "react";
import type { MarketplacePluginSummary } from "../../../../shared/plugin-marketplace-contracts.ts";
import { PluginDetailDialog } from "./plugin-detail-dialog.tsx";
import { MarketplacePluginCard } from "./plugin-marketplace-card.tsx";
import { updateAvailable } from "./plugin-marketplace-utils.ts";
import { usePluginMarketplace } from "./use-plugin-marketplace.ts";

export function PluginMarketplacePage({ returnSession }: { returnSession?: { projectId: string; threadId: string } }) {
  const controller = usePluginMarketplace(returnSession);
  const [selectedPluginId, setSelectedPluginId] = useState<string>();
  const [pendingInstall, setPendingInstall] = useState<MarketplacePluginSummary>();
  const [pendingUpdate, setPendingUpdate] = useState<MarketplacePluginSummary>();
  const [pendingUninstall, setPendingUninstall] = useState<{ id: string; name: string }>();
  const [applyToCurrentSession, setApplyToCurrentSession] = useState(returnSession !== undefined);
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
        <Button
          variant="ghost"
          size="icon"
          disabled={controller.loading}
          aria-label="刷新插件目录"
          title="刷新"
          onClick={() => void controller.refresh()}
        >
          <RefreshCw />
        </Button>
      </header>
      <div className="plugin-marketplace-scroll">
        <main className="plugin-marketplace-content">
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
          {returnSession ? (
            <div className="plugin-marketplace-options">
              <label className="marketplace-endpoint-trust plugin-marketplace-apply-toggle">
                <Checkbox
                  checked={applyToCurrentSession}
                  disabled={
                    controller.installingId !== undefined ||
                    controller.updatingId !== undefined ||
                    controller.uninstallingId !== undefined
                  }
                  onCheckedChange={(checked) => setApplyToCurrentSession(checked === true)}
                />
                <span>安装或更新后应用到当前会话</span>
              </label>
            </div>
          ) : null}

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
            <div className="plugin-marketplace-notice" data-tone="warning" role="status">
              {controller.notice}
            </div>
          ) : null}
          {controller.error ? (
            <div className="plugin-marketplace-notice" data-tone="error" role="alert">
              {controller.error}
              {controller.error.includes("not configured") || controller.error.includes("未配置") ? (
                <Link
                  to="/settings/extensions"
                  search={
                    returnSession
                      ? { returnProjectId: returnSession.projectId, returnThreadId: returnSession.threadId }
                      : {}
                  }
                >
                  打开扩展设置
                </Link>
              ) : null}
            </div>
          ) : null}

          {orphanedInstalled && orphanedInstalled.length > 0 ? (
            <section className="plugin-marketplace-section" aria-labelledby="installed-plugin-heading">
              <div className="plugin-marketplace-section-heading">
                <h3 id="installed-plugin-heading">已安装</h3>
                <span>当前目录中不可用的本地插件</span>
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
        </main>
      </div>
      <PluginDetailDialog
        plugin={selectedPlugin}
        installed={selectedInstalled}
        marketplaceId={controller.page?.marketplaceId}
        open={selectedPluginId !== undefined && (selectedPlugin !== undefined || selectedInstalled !== undefined)}
        mutationPending={mutationPending}
        installing={controller.installingId === selectedPluginId}
        updating={controller.updatingId === selectedPluginId}
        uninstalling={controller.uninstallingId === selectedPluginId}
        onClose={() => setSelectedPluginId(undefined)}
        onInstall={(plugin) => {
          setSelectedPluginId(undefined);
          setPendingInstall(plugin);
        }}
        onUpdate={(plugin) => {
          setSelectedPluginId(undefined);
          setPendingUpdate(plugin);
        }}
        onUninstall={(id, name) => {
          setSelectedPluginId(undefined);
          setPendingUninstall({ id, name });
        }}
      />
      <ConfirmDialog
        open={pendingInstall !== undefined}
        title={`安装 ${pendingInstall?.name ?? "插件"}？`}
        description={`${trustWarning(pendingInstall)}${applyWarning(applyToCurrentSession, returnSession)}`}
        confirmLabel={applyToCurrentSession && returnSession ? "安装并应用" : "安装"}
        onCancel={() => setPendingInstall(undefined)}
        onConfirm={() => {
          const plugin = pendingInstall;
          setPendingInstall(undefined);
          if (plugin) void controller.install(plugin, applyToCurrentSession);
        }}
      />
      <ConfirmDialog
        open={pendingUpdate !== undefined}
        title={`更新 ${pendingUpdate?.name ?? "插件"}？`}
        description={`${trustWarning(pendingUpdate)}${applyWarning(applyToCurrentSession, returnSession)}`}
        confirmLabel={applyToCurrentSession && returnSession ? "更新并应用" : "更新"}
        onCancel={() => setPendingUpdate(undefined)}
        onConfirm={() => {
          const plugin = pendingUpdate;
          setPendingUpdate(undefined);
          if (plugin) void controller.update(plugin, applyToCurrentSession);
        }}
      />
      <ConfirmDialog
        open={pendingUninstall !== undefined}
        title={`卸载 ${pendingUninstall?.name ?? "插件"}？`}
        description={
          applyToCurrentSession && returnSession
            ? "插件将从新会话和当前会话移除。如果当前会话正在运行，确认后会先中止当前运行；replacement 启动失败时将恢复插件和之前的扩展集合。"
            : "插件将不再用于新会话。当前运行中的会话会继续使用原版本，直到重新加载；本地版本会暂时保留，以保护仍在运行或已修改的文件。"
        }
        confirmLabel={applyToCurrentSession && returnSession ? "卸载并应用" : "卸载"}
        onCancel={() => setPendingUninstall(undefined)}
        onConfirm={() => {
          const plugin = pendingUninstall;
          setPendingUninstall(undefined);
          if (plugin) void controller.uninstall(plugin.id, applyToCurrentSession);
        }}
      />
    </>
  );
}

function trustWarning(plugin: MarketplacePluginSummary | undefined): string {
  if (!plugin) return "";
  const nativeWarning = plugin.containsNativeCode ? "该版本包含原生模块或平台二进制。" : "";
  const capabilities = plugin.capabilities?.length ? `声明能力：${plugin.capabilities.join("、")}。` : "";
  return `市场插件是全信任 Pi Extension，可读写本机文件、访问网络并执行进程，不受能力声明限制。${nativeWarning}${capabilities}`;
}

function applyWarning(
  applyToCurrentSession: boolean,
  returnSession: { projectId: string; threadId: string } | undefined,
): string {
  return applyToCurrentSession && returnSession
    ? " 确认后会重新启动当前会话的扩展 worker；如果当前会话正在运行，将先中止当前运行。"
    : "";
}
