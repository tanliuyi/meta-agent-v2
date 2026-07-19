import { PersonalizationSettingsPage } from "@renderer/features/settings/personalization-settings-page";
import { SettingsPage } from "@renderer/features/settings/settings-page";
import { HashRouter, Navigate, Route, Routes } from "react-router";
import { DesktopRoute } from "./desktop-route.tsx";

/** 声明 renderer 路由，并把 Desktop runtime 限定在聊天路由内。 */
export function AppRouter() {
  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<DesktopRoute />} />
        <Route path="/settings" element={<SettingsPage />}>
          <Route index element={<Navigate to="personalization" replace />} />
          <Route path="personalization" element={<PersonalizationSettingsPage />} />
          <Route path="*" element={<Navigate to="personalization" replace />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </HashRouter>
  );
}
