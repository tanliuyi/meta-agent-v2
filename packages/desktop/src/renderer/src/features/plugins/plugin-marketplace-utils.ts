import type {
  InstalledMarketplacePluginSummary,
  MarketplacePluginSummary,
} from "../../../../shared/plugin-marketplace-contracts.ts";

export function cardState(
  plugin: MarketplacePluginSummary | undefined,
  installed: InstalledMarketplacePluginSummary | undefined,
): { label: string; tone: "neutral" | "success" | "info" | "warning" | "danger" } {
  if (installed?.revocation?.status === "blocked") return { label: "已阻止", tone: "danger" };
  if (installed?.revocation?.status === "withdrawn") return { label: "已撤回", tone: "warning" };
  if (installed?.state === "broken") return { label: "已损坏", tone: "danger" };
  if (plugin && updateAvailable(plugin, installed ? [installed] : undefined)) {
    return { label: "可更新", tone: "info" };
  }
  if (installed) return { label: "已安装", tone: "success" };
  if (!plugin?.compatibleVersion) return { label: "不兼容", tone: "neutral" };
  return { label: statusLabel(plugin.status), tone: statusTone(plugin.status) };
}

function statusTone(status: MarketplacePluginSummary["status"]): "neutral" | "success" | "warning" | "danger" {
  if (status === "available") return "success";
  if (status === "blocked") return "danger";
  if (status === "withdrawn" || status === "deprecated") return "warning";
  return "neutral";
}

export function statusLabel(status: "available" | "deprecated" | "withdrawn" | "blocked"): string {
  if (status === "available") return "可用";
  if (status === "deprecated") return "已弃用";
  if (status === "withdrawn") return "已撤回";
  return "已阻止";
}

const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "short",
  day: "numeric",
});

export function formatDate(timestamp: number): string {
  return dateFormatter.format(new Date(timestamp));
}

export function revocationLabel(status: "withdrawn" | "blocked"): string {
  return status === "blocked" ? "当前版本已阻止" : "当前版本已撤回";
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
