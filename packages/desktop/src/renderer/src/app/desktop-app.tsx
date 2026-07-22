import { Sidebar } from "@renderer/components/layout/sidebar";
import { SessionCacheHost } from "@renderer/components/session-cache-host";
import { NodeRuntimeGate } from "@renderer/features/node-runtime/node-runtime-gate";
import { useSessionCache } from "@renderer/state/session-cache-context";
import { DesktopErrorToast } from "./desktop-error-toast.tsx";
import { DesktopWindowTitle } from "./desktop-window-title.tsx";

/** Window shell: catalog navigation stays outside the cached session activities. */
export function DesktopApp() {
  const cache = useSessionCache();
  return (
    <div className="app-frame" data-platform={window.desktop.platform}>
      <DesktopWindowTitle />
      <div className="app-shell">
        <NodeRuntimeGate />
        <Sidebar />
        <SessionCacheHost records={cache.getAllRecords()} activeKey={cache.getActiveKey()} />
        <DesktopErrorToast />
      </div>
    </div>
  );
}
