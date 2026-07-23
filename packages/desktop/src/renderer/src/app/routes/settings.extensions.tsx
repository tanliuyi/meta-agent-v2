import { ExtensionsSettingsPage } from "@renderer/features/settings/extensions-settings-page";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/settings/extensions")({
  component: ExtensionsSettingsPage,
});
