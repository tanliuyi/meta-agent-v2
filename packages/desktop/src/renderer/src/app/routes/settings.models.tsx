import { ModelsSettingsPage } from "@renderer/features/settings/models-settings-page";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/settings/models")({
  component: ModelsSettingsPage,
});
