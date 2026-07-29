import type {
  InstalledMarketplacePluginSummary,
  MarketplacePluginSummary,
} from "../../../../shared/plugin-marketplace-contracts.ts";

export function cardState(
  plugin: MarketplacePluginSummary | undefined,
  installed: InstalledMarketplacePluginSummary | undefined,
): { label: string; tone: "neutral" | "success" | "info" | "warning" | "danger" } {
  if (installed?.state === "broken") return { label: "已损坏", tone: "danger" };
  if (plugin && updateAvailable(plugin, installed ? [installed] : undefined)) {
    return { label: "可更新", tone: "info" };
  }
  if (installed) return { label: "已安装", tone: "success" };
  if (!plugin?.compatibleVersion) return { label: "不兼容", tone: "neutral" };
  return { label: statusLabel(plugin.status), tone: statusTone(plugin.status) };
}

export function statusTone(status: MarketplacePluginSummary["status"]): "success" | "warning" {
  return status === "available" ? "success" : "warning";
}

export function statusLabel(status: MarketplacePluginSummary["status"]): string {
  return status === "available" ? "可用" : "已弃用";
}

const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "short",
  day: "numeric",
});

export function formatDate(timestamp: number): string {
  return dateFormatter.format(new Date(timestamp));
}

export function updateAvailable(
  plugin: MarketplacePluginSummary,
  installed: InstalledMarketplacePluginSummary[] | undefined,
): boolean {
  const current = installed?.find((entry) => entry.id === plugin.id);
  return (
    current !== undefined && plugin.compatibleVersion !== undefined && current.version !== plugin.compatibleVersion
  );
}
