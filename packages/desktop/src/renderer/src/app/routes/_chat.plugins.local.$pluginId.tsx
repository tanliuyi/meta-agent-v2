import { LocalPluginDetailPage } from "@renderer/features/plugins/local-plugin-detail-page";
import { settingsReturnSession } from "@renderer/state/settings-navigation";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_chat/plugins/local/$pluginId")({ component: LocalPluginDetailRoute });

function LocalPluginDetailRoute() {
  const { pluginId } = Route.useParams();
  return (
    <LocalPluginDetailPage pluginId={pluginId} returnSession={settingsReturnSession(Route.useSearch()) ?? undefined} />
  );
}
