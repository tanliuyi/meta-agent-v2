import { ArchivesSettingsPage } from "@renderer/features/settings/archives/archives-settings-page";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/settings/archives")({
  component: ArchivesSettingsPage,
});
