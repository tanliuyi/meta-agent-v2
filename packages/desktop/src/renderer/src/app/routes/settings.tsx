import { DesktopWindowTitle } from "@renderer/app/desktop-window-title";
import { SettingsPage } from "@renderer/features/settings/settings-page";
import { ToastProvider } from "@renderer/shared/ui/toast-provider";
import { useSessionCache } from "@renderer/state/session-cache-context";
import { validateSettingsSearch } from "@renderer/state/settings-navigation";
import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useEffect } from "react";

export const Route = createFileRoute("/settings")({
  validateSearch: validateSettingsSearch,
  component: SettingsRoute,
  notFoundComponent: () => <Navigate to="/settings/personalization" search={(previous) => previous} replace />,
});

function SettingsRoute() {
  const sessionCache = useSessionCache();
  useEffect(() => {
    sessionCache.setActiveKey(null);
  }, [sessionCache]);

  return (
    <ToastProvider label="设置通知" swipeDirection="right">
      <DesktopWindowTitle />
      <div className="app-shell">
        <SettingsPage />
      </div>
    </ToastProvider>
  );
}
