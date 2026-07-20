import { SettingsPage } from "@renderer/features/settings/settings-page";
import { createFileRoute, Navigate } from "@tanstack/react-router";

export const Route = createFileRoute("/settings")({
  component: SettingsPage,
  notFoundComponent: () => <Navigate to="/settings/personalization" replace />,
});
