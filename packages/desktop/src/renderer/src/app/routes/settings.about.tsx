import { AboutSettingsPage } from "@renderer/features/settings/about/about-settings-page";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/settings/about")({
  component: AboutSettingsPage,
});
