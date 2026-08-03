import { Link } from "@tanstack/react-router";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right.mjs";

export type PluginDetailSource = "marketplace" | "local";

interface PluginMarketplaceBreadcrumbProps {
  source: PluginDetailSource;
  currentLabel: string;
}

export function PluginMarketplaceBreadcrumb({ source, currentLabel }: PluginMarketplaceBreadcrumbProps) {
  const sourceLabel = source === "marketplace" ? "市场" : "本地";
  return (
    <nav className="plugin-marketplace-breadcrumb" aria-label="插件中心路径">
      <Link
        to="/plugins"
        search={(previous) => ({
          ...previous,
          query: source === "local" ? undefined : previous.query,
          view: source,
        })}
        className="plugin-marketplace-breadcrumb-link"
      >
        插件中心
      </Link>
      <ChevronRight aria-hidden="true" />
      <span className="plugin-marketplace-breadcrumb-muted">{sourceLabel}</span>
      <ChevronRight aria-hidden="true" />
      <span className="plugin-marketplace-breadcrumb-current" aria-current="page">
        {currentLabel}
      </span>
    </nav>
  );
}
