import { DesktopProvider } from "@renderer/state/desktop-context";
import { DesktopApp } from "./desktop-app.tsx";

/** 渲染聊天工作台；离开聊天路由时由 TanStack Router 正常卸载。 */
export function DesktopRoute() {
  return (
    <DesktopProvider>
      <DesktopApp />
    </DesktopProvider>
  );
}
