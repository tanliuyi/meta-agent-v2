import { AuthSettingsPage } from "@renderer/features/settings/auth-settings-page";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/settings/auth")({
  component: AuthSettingsPage,
});
