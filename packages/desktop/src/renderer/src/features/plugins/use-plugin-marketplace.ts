import { useCallback, useEffect, useRef, useState } from "react";
import type {
  InstalledMarketplacePluginsSnapshot,
  MarketplacePluginPage,
  MarketplacePluginScope,
  MarketplacePluginSummary,
} from "../../../../shared/plugin-marketplace-contracts.ts";

export interface PluginMarketplaceController {
  page?: MarketplacePluginPage;
  installed?: InstalledMarketplacePluginsSnapshot;
  query: string;
  loading: boolean;
  installingId?: string;
  updatingId?: string;
  uninstallingId?: string;
  settingScopeId?: string;
  error?: string;
  notice?: string;
  clearError(): void;
  clearNotice(): void;
  setQuery(query: string): void;
  refresh(): Promise<void>;
  install(plugin: MarketplacePluginSummary): Promise<void>;
  update(plugin: MarketplacePluginSummary): Promise<void>;
  uninstall(pluginId: string): Promise<void>;
  setScope(pluginId: string, scope: MarketplacePluginScope, projectIds?: string[]): Promise<void>;
}

export function usePluginMarketplace(enabled = true, initialQuery = ""): PluginMarketplaceController {
  const [page, setPage] = useState<MarketplacePluginPage>();
  const [installed, setInstalled] = useState<InstalledMarketplacePluginsSnapshot>();
  const [query, setQuery] = useState(initialQuery);
  const [loading, setLoading] = useState(true);
  const [installingId, setInstallingId] = useState<string>();
  const [updatingId, setUpdatingId] = useState<string>();
  const [uninstallingId, setUninstallingId] = useState<string>();
  const [settingScopeId, setSettingScopeId] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const mounted = useRef(true);
  const requestGeneration = useRef(0);
  const installedSnapshotEpoch = useRef(0);

  const load = useCallback(async (value: string) => {
    const generation = ++requestGeneration.current;
    const installedEpoch = installedSnapshotEpoch.current;
    setLoading(true);
    setError(undefined);
    setNotice(undefined);
    const [pageResult, installedResult] = await Promise.allSettled([
      window.desktop.marketplace.listPlugins({ query: value, limit: 50 }),
      window.desktop.marketplace.getInstalled(),
    ]);
    if (!mounted.current || generation !== requestGeneration.current) return;
    const resolved = resolvePluginMarketplaceLoad(
      pageResult,
      installedResult,
      installedEpoch === installedSnapshotEpoch.current,
    );
    if (resolved.page) setPage(resolved.page);
    if (resolved.installed) setInstalled(resolved.installed);
    setError(resolved.error);
    setLoading(false);
  }, []);

  useEffect(() => {
    setQuery(initialQuery);
  }, [initialQuery]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!enabled) {
      requestGeneration.current += 1;
      setLoading(false);
      return;
    }
    const timer = setTimeout(() => void load(query), query ? 250 : 0);
    return () => clearTimeout(timer);
  }, [enabled, load, query]);

  const refresh = useCallback(() => load(query), [load, query]);
  const install = useCallback(
    async (plugin: MarketplacePluginSummary) => {
      if (!installed || !canInstallMarketplacePlugin(plugin) || installingId || updatingId || uninstallingId) return;
      installedSnapshotEpoch.current += 1;
      setInstallingId(plugin.id);
      setError(undefined);
      setNotice(undefined);
      try {
        const result = await window.desktop.marketplace.installPlugin({
          requestId: crypto.randomUUID(),
          expectedRevision: installed.revision,
          pluginId: plugin.id,
          version: plugin.compatibleVersion,
          confirmFullTrust: true,
        });
        if (!mounted.current) return;
        installedSnapshotEpoch.current += 1;
        setInstalled(result.status === "conflict" ? result.current : result.snapshot);
        if (result.status === "conflict") setError("插件安装状态已变化，请重试");
        else if (result.status === "already-installed") setNotice("插件已在本机安装，已同步最新状态");
        else if (result.status === "installed" && result.recoveryPending) {
          setNotice("插件已提交，剩余文件状态将在启动恢复中完成");
        } else if (result.status === "installed") {
          setNotice("插件已安装；当前会话可运行 /reload 重新加载");
        }
      } catch (reason) {
        if (mounted.current) setError(marketplaceErrorMessage(reason));
      } finally {
        if (mounted.current) setInstallingId(undefined);
      }
    },
    [installed, installingId, updatingId, uninstallingId],
  );

  const update = useCallback(
    async (plugin: MarketplacePluginSummary) => {
      if (!installed || !canInstallMarketplacePlugin(plugin) || installingId || updatingId || uninstallingId) return;
      installedSnapshotEpoch.current += 1;
      setUpdatingId(plugin.id);
      setError(undefined);
      setNotice(undefined);
      try {
        const result = await window.desktop.marketplace.updatePlugin({
          requestId: crypto.randomUUID(),
          expectedRevision: installed.revision,
          pluginId: plugin.id,
          version: plugin.compatibleVersion,
          confirmFullTrust: true,
        });
        if (!mounted.current) return;
        installedSnapshotEpoch.current += 1;
        setInstalled(result.status === "conflict" ? result.current : result.snapshot);
        if (result.status === "conflict") setError("插件安装状态已变化，请重试");
        else if (result.status === "not-installed") setNotice("插件已不在本机，无法更新，已同步最新状态");
        else if (result.status === "same-version") setNotice("插件已是该版本，无需更新");
        else if (result.status === "updated" && result.recoveryPending) {
          setNotice("更新已提交，剩余文件状态将在启动恢复中完成");
        } else if (result.status === "updated") {
          setNotice("插件已更新；当前会话可运行 /reload 重新加载");
        }
      } catch (reason) {
        if (mounted.current) setError(marketplaceErrorMessage(reason));
      } finally {
        if (mounted.current) setUpdatingId(undefined);
      }
    },
    [installed, installingId, updatingId, uninstallingId],
  );

  const uninstall = useCallback(
    async (pluginId: string) => {
      if (!installed || installingId || updatingId || uninstallingId) return;
      installedSnapshotEpoch.current += 1;
      setUninstallingId(pluginId);
      setError(undefined);
      setNotice(undefined);
      try {
        const result = await window.desktop.marketplace.uninstallPlugin({
          requestId: crypto.randomUUID(),
          expectedRevision: installed.revision,
          pluginId,
          confirmRemoval: true,
        });
        if (!mounted.current) return;
        installedSnapshotEpoch.current += 1;
        setInstalled(result.status === "conflict" ? result.current : result.snapshot);
        if (result.status === "conflict") setError("插件安装状态已变化，请重试");
        else if (result.status === "not-installed") setNotice("插件已被卸载，已同步最新状态");
        else if (result.status === "uninstalled" && result.recoveryPending) {
          setNotice("卸载已提交，剩余文件状态将在启动恢复中完成");
        } else if (result.status === "uninstalled") {
          setNotice("插件已卸载；当前会话可运行 /reload 重新加载");
        }
      } catch (reason) {
        if (mounted.current) setError(marketplaceErrorMessage(reason));
      } finally {
        if (mounted.current) setUninstallingId(undefined);
      }
    },
    [installed, installingId, updatingId, uninstallingId],
  );

  const setScope = useCallback(
    async (pluginId: string, scope: MarketplacePluginScope, projectIds?: string[]) => {
      if (!installed || installingId || updatingId || uninstallingId || settingScopeId) return;
      if (scope === "project" && (!projectIds || projectIds.length === 0)) return;
      installedSnapshotEpoch.current += 1;
      setSettingScopeId(pluginId);
      setError(undefined);
      setNotice(undefined);
      try {
        const result = await window.desktop.marketplace.setPluginScope({
          requestId: crypto.randomUUID(),
          expectedRevision: installed.revision,
          pluginId,
          scope,
          projectIds: scope === "project" ? projectIds : undefined,
        });
        if (!mounted.current) return;
        installedSnapshotEpoch.current += 1;
        setInstalled(result.status === "conflict" ? result.current : result.snapshot);
        if (result.status === "conflict") setError("插件安装状态已变化，请重试");
        else if (result.status === "not-installed") setNotice("插件已不在本机，已同步最新状态");
        else if (result.status === "saved") {
          setNotice(scope === "global" ? "插件已对所有项目生效" : "插件作用域已更新；当前会话可运行 /reload 重新加载");
        }
      } catch (reason) {
        if (mounted.current) setError(marketplaceErrorMessage(reason));
      } finally {
        if (mounted.current) setSettingScopeId(undefined);
      }
    },
    [installed, installingId, updatingId, uninstallingId, settingScopeId],
  );

  return {
    page,
    installed,
    query,
    loading,
    installingId,
    updatingId,
    uninstallingId,
    settingScopeId,
    error,
    notice,
    clearError: () => setError(undefined),
    clearNotice: () => setNotice(undefined),
    setQuery,
    refresh,
    install,
    update,
    uninstall,
    setScope,
  };
}

export function canInstallMarketplacePlugin(
  plugin: MarketplacePluginSummary,
): plugin is MarketplacePluginSummary & { compatibleVersion: string } {
  return plugin.compatibleVersion !== undefined && (plugin.status === "available" || plugin.status === "deprecated");
}

/** 详情路由按 pluginId 直达：列表页未命中时仍需要按 ID 查询，不依赖 limit 内的页。 */
export function needsPluginDetailLookup(page: MarketplacePluginPage | undefined, pluginId: string): boolean {
  return !page?.plugins.some((entry) => entry.id === pluginId);
}

export type MarketplacePluginDetailLookup =
  | { pluginId: string; status: "loading" }
  | { pluginId: string; status: "found"; plugin: MarketplacePluginSummary }
  | { pluginId: string; status: "missing" }
  | { pluginId: string; status: "error"; error: string };

export async function loadMarketplacePluginDetail(
  pluginId: string,
  getPlugin: (id: string) => Promise<MarketplacePluginSummary | null>,
): Promise<MarketplacePluginDetailLookup> {
  try {
    const plugin = await getPlugin(pluginId);
    return plugin ? { pluginId, status: "found", plugin } : { pluginId, status: "missing" };
  } catch (reason) {
    return { pluginId, status: "error", error: marketplaceErrorMessage(reason) };
  }
}

export function resolveMarketplaceDetailPlugin(
  page: MarketplacePluginPage | undefined,
  pluginId: string,
  lookup: MarketplacePluginDetailLookup | undefined,
): MarketplacePluginSummary | undefined {
  const onPage = page?.plugins.find((entry) => entry.id === pluginId);
  return onPage ?? (lookup?.pluginId === pluginId && lookup.status === "found" ? lookup.plugin : undefined);
}

export function resolvePluginMarketplaceLoad(
  page: PromiseSettledResult<MarketplacePluginPage>,
  installed: PromiseSettledResult<InstalledMarketplacePluginsSnapshot>,
  acceptInstalled: boolean,
): {
  page?: MarketplacePluginPage;
  installed?: InstalledMarketplacePluginsSnapshot;
  error?: string;
} {
  const failures = [
    ...(page.status === "rejected" ? [page.reason] : []),
    ...(installed.status === "rejected" ? [installed.reason] : []),
  ];
  return {
    ...(page.status === "fulfilled" ? { page: page.value } : {}),
    ...(installed.status === "fulfilled" && acceptInstalled ? { installed: installed.value } : {}),
    ...(failures.length > 0 ? { error: marketplaceErrorMessage(failures[0]) } : {}),
  };
}

export function marketplaceErrorMessage(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason);
  if (message.includes("Marketplace API URL is not configured")) return "尚未配置插件市场 API。";
  return message.replace(/^Error invoking remote method '[^']+': Error:\s*/, "");
}
