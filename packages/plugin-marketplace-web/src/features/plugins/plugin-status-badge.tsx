import type { PluginStatus } from "@/api.ts";
import { Badge } from "@/components/ui/badge.tsx";

export function PluginStatusBadge({ status }: { status: PluginStatus }) {
  const labels: Record<PluginStatus, string> = {
    available: "可用",
    deprecated: "已弃用",
  };
  const variant = status === "available" ? "default" : "secondary";
  return <Badge variant={variant}>{labels[status]}</Badge>;
}
