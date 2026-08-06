import { AutoTitleSettingsPage } from "@renderer/features/settings/auto-title/auto-title-settings-page";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/settings/auto-title")({
  component: AutoTitleSettingsPage,
});
