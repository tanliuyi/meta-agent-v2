import { CodexPluginDetailPage } from "@renderer/features/plugins/codex-plugin-detail-page";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_chat/plugins/$pluginId")({ component: PluginMarketplaceDetailRoute });

function PluginMarketplaceDetailRoute() {
  const { pluginId } = Route.useParams();
  return <CodexPluginDetailPage pluginId={pluginId} />;
}
