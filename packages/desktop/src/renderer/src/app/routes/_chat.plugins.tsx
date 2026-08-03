import { type SettingsSearch, validateSettingsSearch } from "@renderer/state/settings-navigation";
import { createFileRoute, Outlet } from "@tanstack/react-router";

export type PluginCenterView = "marketplace" | "local";

export interface PluginCenterSearch extends SettingsSearch {
  query?: string;
  view?: PluginCenterView;
}

export function validatePluginCenterSearch(search: Record<string, unknown>): PluginCenterSearch {
  const settingsSearch = validateSettingsSearch(search);
  const view = search.view === "local" || search.view === "marketplace" ? search.view : undefined;
  const query = typeof search.query === "string" && search.query.length > 0 ? search.query : undefined;
  return view || query ? { ...settingsSearch, ...(query ? { query } : {}), ...(view ? { view } : {}) } : settingsSearch;
}

export const Route = createFileRoute("/_chat/plugins")({
  validateSearch: validatePluginCenterSearch,
  component: PluginMarketplaceLayout,
});

function PluginMarketplaceLayout() {
  return (
    <div className="session-surface-shell plugin-marketplace-shell">
      <Outlet />
    </div>
  );
}
