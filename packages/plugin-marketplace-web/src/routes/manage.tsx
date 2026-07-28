import { createFileRoute } from "@tanstack/react-router";
import { PluginManagementPage } from "@/features/plugins/plugin-management-page.tsx";

export const Route = createFileRoute("/manage")({
  component: PluginManagementPage,
});
