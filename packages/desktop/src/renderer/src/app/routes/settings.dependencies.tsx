import { DependenciesSettingsPage } from "@renderer/features/settings/dependencies-settings-page";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/settings/dependencies")({
  component: DependenciesSettingsPage,
});
