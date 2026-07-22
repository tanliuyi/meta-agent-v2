import { SettingsPage } from "@renderer/features/settings/settings-page";
import { validateSettingsSearch } from "@renderer/state/settings-navigation";
import { createFileRoute, Navigate } from "@tanstack/react-router";

export const Route = createFileRoute("/settings")({
  validateSearch: validateSettingsSearch,
  component: SettingsPage,
  notFoundComponent: () => <Navigate to="/settings/personalization" search={(previous) => previous} replace />,
});
