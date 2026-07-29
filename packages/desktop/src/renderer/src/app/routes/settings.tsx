import { DesktopWindowTitle } from "@renderer/app/desktop-window-title";
import { SettingsPage } from "@renderer/features/settings/settings-page";
import { ToastProvider } from "@renderer/shared/ui/toast-provider";
import { validateSettingsSearch } from "@renderer/state/settings-navigation";
import { createFileRoute, Navigate } from "@tanstack/react-router";

export const Route = createFileRoute("/settings")({
  validateSearch: validateSettingsSearch,
  component: SettingsRoute,
  notFoundComponent: () => <Navigate to="/settings/personalization" search={(previous) => previous} replace />,
});

function SettingsRoute() {
  return (
    <ToastProvider label="Meta Agent 设置通知" swipeDirection="right">
      <DesktopWindowTitle />
      <div className="app-shell">
        <SettingsPage />
      </div>
    </ToastProvider>
  );
}
