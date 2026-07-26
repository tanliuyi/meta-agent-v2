import { Button } from "@renderer/shared/ui/button";
import { Checkbox } from "@renderer/shared/ui/checkbox";
import { ConfirmDialog } from "@renderer/shared/ui/confirm-dialog";
import { Input } from "@renderer/shared/ui/input";
import { Link } from "@tanstack/react-router";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.mjs";
import Search from "lucide-react/dist/esm/icons/search.mjs";
import { useState } from "react";
import type {
  InstalledMarketplacePluginSummary,
  MarketplacePluginSummary,
} from "../../../../shared/plugin-marketplace-contracts.ts";
import { canInstallMarketplacePlugin, usePluginMarketplace } from "./use-plugin-marketplace.ts";

export function PluginMarketplacePage({ returnSession }: { returnSession?: { projectId: string; threadId: string } }) {
  const controller = usePluginMarketplace(returnSession);
  const [pendingInstall, setPendingInstall] = useState<MarketplacePluginSummary>();
  const [pendingUpdate, setPendingUpdate] = useState<MarketplacePluginSummary>();
  const [pendingUninstall, setPendingUninstall] = useState<{ id: string; name: string }>();
  const [applyToCurrentSession, setApplyToCurrentSession] = useState(returnSession !== undefined);

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

          {controller.installed?.plugins.some(
            (installed) => !controller.page?.plugins.some((plugin) => plugin.id === installed.id),
          ) ? (
            <section className="plugin-marketplace-list" aria-label="已安装插件">
              {controller.installed.plugins
                .filter((installed) => !controller.page?.plugins.some((plugin) => plugin.id === installed.id))
                .map((installed) => (
                  <article key={installed.id} className="plugin-marketplace-row">
                    <div className="plugin-marketplace-row-main">
                      <div className="plugin-marketplace-row-title">
                        <strong>{installed.displayName}</strong>
                        <span>{installed.marketplaceId}</span>
                      </div>
                      <div className="plugin-marketplace-row-meta">
                        <span>{installed.version}</span>
                        {installed.containsNativeCode ? <span>Native</span> : null}
                        <span>
                          {installed.revocation?.status === "blocked"
                            ? "已阻止"
                            : installed.revocation?.status === "withdrawn"
                              ? "已撤回"
                              : installed.state === "broken"
                                ? "已损坏"
                                : "已安装"}
                        </span>
                      </div>
                    </div>
                    <Button
                      size="sm"
                      disabled={
                        controller.installingId !== undefined ||
                        controller.updatingId !== undefined ||
                        controller.uninstallingId !== undefined
                      }
                      onClick={() => setPendingUninstall({ id: installed.id, name: installed.displayName })}
                    >
                      {controller.uninstallingId === installed.id ? "卸载中" : "卸载"}
                    </Button>
                  </article>
                ))}
            </section>
          ) : null}

          <section className="plugin-marketplace-list" aria-label="插件目录" aria-busy={controller.loading}>
            {controller.page?.plugins.map((plugin) => (
              <article key={plugin.id} className="plugin-marketplace-row" data-status={plugin.status}>
                <div className="plugin-marketplace-row-main">
                  <div className="plugin-marketplace-row-title">
                    <strong>{plugin.name}</strong>
                    <span>{plugin.publisher.displayName}</span>
                  </div>
                  <p>{plugin.description}</p>
                  <div className="plugin-marketplace-row-meta">
                    <span>{plugin.compatibleVersion ?? plugin.latestVersion ?? "无兼容版本"}</span>
                    {plugin.containsNativeCode ? <span>Native</span> : null}
                    <span>{statusLabel(plugin.status)}</span>
                    {installedRevocation(plugin.id, controller.installed?.plugins) ? (
                      <span>
                        {revocationLabel(installedRevocation(plugin.id, controller.installed?.plugins)!.status)}
                      </span>
                    ) : null}
                  </div>
                </div>
                <Button
                  size="sm"
                  disabled={
                    controller.installingId !== undefined ||
                    controller.updatingId !== undefined ||
                    controller.uninstallingId !== undefined ||
                    (!controller.installed?.plugins.some((installed) => installed.id === plugin.id) &&
                      !canInstallMarketplacePlugin(plugin))
                  }
                  onClick={() => {
                    if (updateAvailable(plugin, controller.installed?.plugins)) setPendingUpdate(plugin);
                    else if (controller.installed?.plugins.some((installed) => installed.id === plugin.id)) {
                      setPendingUninstall({ id: plugin.id, name: plugin.name });
                    } else setPendingInstall(plugin);
                  }}
                >
                  {controller.updatingId === plugin.id
                    ? "更新中"
                    : controller.uninstallingId === plugin.id
                      ? "卸载中"
                      : updateAvailable(plugin, controller.installed?.plugins)
                        ? "更新"
                        : controller.installed?.plugins.some((installed) => installed.id === plugin.id)
                          ? "卸载"
                          : controller.installingId === plugin.id
                            ? "安装中"
                            : "安装"}
                </Button>
              </article>
            ))}
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

function installedRevocation(pluginId: string, installed: InstalledMarketplacePluginSummary[] | undefined) {
  return installed?.find((entry) => entry.id === pluginId)?.revocation;
}

function revocationLabel(status: "withdrawn" | "blocked"): string {
  return status === "blocked" ? "当前版本已阻止" : "当前版本已撤回";
}

function updateAvailable(
  plugin: MarketplacePluginSummary,
  installed: InstalledMarketplacePluginSummary[] | undefined,
): boolean {
  const current = installed?.find((entry) => entry.id === plugin.id);
  return (
    current !== undefined && plugin.compatibleVersion !== undefined && current.version !== plugin.compatibleVersion
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

function statusLabel(status: "available" | "deprecated" | "withdrawn" | "blocked"): string {
  if (status === "available") return "可用";
  if (status === "deprecated") return "已弃用";
  if (status === "withdrawn") return "已撤回";
  return "已阻止";
}
