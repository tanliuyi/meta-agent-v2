import { PersonalizationSettingsPage } from "@renderer/features/settings/personalization-settings-page";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/settings/personalization")({
  component: PersonalizationSettingsPage,
});
