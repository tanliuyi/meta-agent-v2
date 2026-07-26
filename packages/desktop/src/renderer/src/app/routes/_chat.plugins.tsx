import { PluginMarketplacePage } from "@renderer/features/plugins/plugin-marketplace-page";
import { settingsReturnSession, validateSettingsSearch } from "@renderer/state/settings-navigation";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_chat/plugins")({
  validateSearch: validateSettingsSearch,
  component: PluginMarketplaceRoute,
});

function PluginMarketplaceRoute() {
  const returnSession = settingsReturnSession(Route.useSearch());
  return <PluginMarketplacePage returnSession={returnSession ?? undefined} />;
}
