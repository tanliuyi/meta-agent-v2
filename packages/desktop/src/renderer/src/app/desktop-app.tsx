import { Sidebar } from "@renderer/components/layout/sidebar";
import { Topbar } from "@renderer/components/layout/topbar";
import { NodeRuntimeGate } from "@renderer/features/node-runtime/node-runtime-gate";
import { DesktopErrorToast } from "./desktop-error-toast.tsx";
import { DesktopSessionWorkspace } from "./desktop-session-workspace.tsx";
import { DesktopWindowTitle } from "./desktop-window-title.tsx";

/** 组合聊天路由的静态窗口框架；动态状态由叶子订阅组件读取。 */
export function DesktopApp() {
  const platform = window.desktop.platform;
  return (
    <div className="app-frame" data-platform={platform}>
      <DesktopWindowTitle />
      <div className="app-shell">
        <NodeRuntimeGate />
        <Sidebar />
        <section className="workspace">
          <Topbar />
          <DesktopSessionWorkspace />
        </section>
        <DesktopErrorToast />
      </div>
    </div>
  );
}
