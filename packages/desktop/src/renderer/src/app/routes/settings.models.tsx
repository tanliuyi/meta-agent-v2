import { ProvidersSettingsPage } from "@renderer/features/settings/providers-settings-page";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/settings/models")({
  component: ProvidersSettingsPage,
});
