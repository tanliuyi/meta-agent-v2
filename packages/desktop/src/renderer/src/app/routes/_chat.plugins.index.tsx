import { PluginMarketplacePage } from "@renderer/features/plugins/plugin-marketplace-page";
import { settingsReturnSession } from "@renderer/state/settings-navigation";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_chat/plugins/")({ component: PluginMarketplaceIndexRoute });

function PluginMarketplaceIndexRoute() {
  const search = Route.useSearch();
  return (
    <PluginMarketplacePage
      initialQuery={search.query}
      initialView={search.view}
      returnSession={settingsReturnSession(search) ?? undefined}
    />
  );
}
