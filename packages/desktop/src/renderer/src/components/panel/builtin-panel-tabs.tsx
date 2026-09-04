import GitBranch from "lucide-react/dist/esm/icons/git-branch.mjs";
import Globe from "lucide-react/dist/esm/icons/globe.mjs";
import MessageSquare from "lucide-react/dist/esm/icons/message-square.mjs";
import { registerWorkbenchPanelTab } from "../../state/panel-tab-registry.ts";
import { BrowserPanelTab } from "./browser/browser-panel-tab.tsx";
import { BROWSER_PANEL_KIND, NEW_SESSION_PANEL_KIND, PROJECT_PANEL_KIND } from "./builtin-panel-kinds.ts";
import { ProjectPanel } from "./project-panel.tsx";
import { NewSessionDraft } from "./session/new-session-draft.tsx";

let registered = false;

/** 注册桌面内置面板 tab（新会话草稿/审查与资源管理）；幂等，可重复调用。
 * 终端不在此注册：终端是"一 tab 一终端"的多开 tab（见 open-workbench-panel 的 terminalOption）。 */
export function registerBuiltinPanelTabs(): void {
  if (registered) return;
  registered = true;
  registerWorkbenchPanelTab({
    kind: NEW_SESSION_PANEL_KIND,
    label: "新会话",
    icon: <MessageSquare size={14} />,
    component: NewSessionDraft,
    order: 0,
  });
  registerWorkbenchPanelTab({
    kind: PROJECT_PANEL_KIND,
    label: "审查与资源管理",
    icon: <GitBranch size={14} />,
    component: ProjectPanel,
    order: 1,
  });
  registerWorkbenchPanelTab({
    kind: BROWSER_PANEL_KIND,
    label: "浏览器",
    icon: <Globe size={14} />,
    component: BrowserPanelTab,
    order: 3,
  });
}
