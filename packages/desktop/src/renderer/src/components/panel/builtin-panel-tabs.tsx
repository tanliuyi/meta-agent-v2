import Files from "lucide-react/dist/esm/icons/files.mjs";
import MessageSquare from "lucide-react/dist/esm/icons/message-square.mjs";
import TerminalSquare from "lucide-react/dist/esm/icons/square-terminal.mjs";
import { registerWorkbenchPanelTab } from "../../state/panel-tab-registry.ts";
import { FILES_PANEL_KIND, NEW_SESSION_PANEL_KIND } from "./builtin-panel-kinds.ts";
import { FilePanel } from "./files/file-panel.tsx";
import { NewSessionDraft } from "./session/new-session-draft.tsx";
import { TerminalPanel } from "./terminal/terminal-panel.tsx";

let registered = false;

/** 注册桌面内置面板 tab（新会话草稿/终端/资源管理）；幂等，可重复调用。 */
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
    kind: "terminal",
    label: "终端",
    icon: <TerminalSquare size={14} />,
    component: TerminalPanel,
    order: 1,
  });
  registerWorkbenchPanelTab({
    kind: FILES_PANEL_KIND,
    label: "资源管理",
    icon: <Files size={14} />,
    component: FilePanel,
    order: 2,
  });
}
