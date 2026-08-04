import { workbenchTabKey } from "../../state/workbench-tab-context.tsx";
import {
  useSessionControlSelector,
  useSessionScope,
  useSessionWorkbenchSelector,
  useSessionWorkbenchTabs,
  useWorkbenchAccessible,
} from "../session-context.tsx";
import { OpenWorkbenchPanel } from "./open-workbench-panel.tsx";

/** Workbench state is stored with the cached session record. */
export function WorkbenchPanel() {
  const { record } = useSessionScope();
  const accessible = useWorkbenchAccessible();
  const panelOpen = useSessionWorkbenchSelector((workbench) => workbench?.panelOpen === true);
  const panelWidth = useSessionWorkbenchSelector((workbench) => workbench?.panelWidth ?? 0);
  const tabs = useSessionWorkbenchTabs();
  if (!accessible) return null;
  return (
    <OpenWorkbenchPanel
      open={panelOpen}
      width={panelWidth}
      tabs={tabs.tabs}
      activeKey={tabs.activeKey}
      onActivate={tabs.activate}
      onCloseTab={(tab) => {
        // 关闭终端 tab 时释放其 PTY（进程级终止）；兼容旧版持久化的 panel:terminal tab。
        const terminalId =
          tab.kind === "terminal"
            ? tab.terminalId
            : tab.kind === "panel" && tab.panel === "terminal"
              ? "panel"
              : undefined;
        if (terminalId) {
          void window.desktop.terminals.dispose(record.identity.projectId, record.identity.threadId, terminalId);
        }
        tabs.closeTab(workbenchTabKey(tab));
      }}
      onOpenNewPanel={tabs.openNewPanel}
      onOpenPanelTab={tabs.openPanelTab}
    />
  );
}
