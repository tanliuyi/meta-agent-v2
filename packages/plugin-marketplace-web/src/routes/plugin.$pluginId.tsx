import { createFileRoute } from "@tanstack/react-router";
import { PluginDetailPage } from "@/features/catalog/plugin-detail-page.tsx";

export const Route = createFileRoute("/plugin/$pluginId")({
  component: PluginRoute,
});

function PluginRoute() {
  const { pluginId } = Route.useParams();
  return <PluginDetailPage pluginId={pluginId} />;
}
