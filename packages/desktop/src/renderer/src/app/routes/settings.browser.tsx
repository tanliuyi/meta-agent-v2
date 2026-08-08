import { BrowserSettingsPage } from "@renderer/features/settings/browser/browser-settings-page";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/settings/browser")({
  component: BrowserSettingsPage,
});
