import type { PluginStatus } from "@/api.ts";
import { Badge } from "@/components/ui/badge.tsx";

export function PluginStatusBadge({ status }: { status: PluginStatus }) {
  const labels: Record<PluginStatus, string> = {
    available: "可用",
    deprecated: "已弃用",
    withdrawn: "已撤回",
    blocked: "已阻止",
  };
  const variant = status === "available" ? "default" : status === "deprecated" ? "secondary" : "destructive";
  return <Badge variant={variant}>{labels[status]}</Badge>;
}
