import { Link } from "@tanstack/react-router";
import ArrowLeft from "lucide-react/dist/esm/icons/arrow-left.mjs";

export function PluginDetailBackLink({ source }: { source: "marketplace" | "local" }) {
  return (
    <div className="plugin-marketplace-detail-back-shell">
      <Link
        to="/plugins"
        search={(previous) => ({
          ...previous,
          query: source === "local" ? undefined : previous.query,
          view: source,
        })}
        className="plugin-marketplace-detail-back"
        aria-label="返回插件中心"
        title="返回插件中心"
      >
        <ArrowLeft aria-hidden="true" />
        <span>返回插件中心</span>
      </Link>
    </div>
  );
}
