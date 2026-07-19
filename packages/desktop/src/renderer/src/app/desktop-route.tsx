import { DesktopProvider } from "@renderer/state/desktop-context";
import { DesktopApp } from "./desktop-app.tsx";

/** 为聊天工作台创建 route-scoped Desktop runtime，离开路由时释放 session 订阅。 */
export function DesktopRoute() {
  return (
    <DesktopProvider>
      <DesktopApp />
    </DesktopProvider>
  );
}
