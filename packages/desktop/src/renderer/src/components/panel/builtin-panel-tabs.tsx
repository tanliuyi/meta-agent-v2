import Files from "lucide-react/dist/esm/icons/files.mjs";
import ListTodo from "lucide-react/dist/esm/icons/list-todo.mjs";
import MessageSquare from "lucide-react/dist/esm/icons/message-square.mjs";
import TerminalSquare from "lucide-react/dist/esm/icons/square-terminal.mjs";
import { registerWorkbenchPanelTab } from "../../state/panel-tab-registry.ts";
import { FilePanel } from "./files/file-panel.tsx";
import { NewSessionDraft } from "./session/new-session-draft.tsx";
import { TaskPanel } from "./tasks/task-panel.tsx";
import { TerminalPanel } from "./terminal/terminal-panel.tsx";

/** 新会话草稿面板的注册 kind；提交成功后由草稿组件自行关闭该 tab。 */
export const NEW_SESSION_PANEL_KIND = "draft";

let registered = false;

/** 注册桌面内置面板 tab（新会话草稿/终端/资源管理/侧边任务）；幂等，可重复调用。 */
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
    kind: "files",
    label: "资源管理",
    icon: <Files size={14} />,
    component: FilePanel,
    order: 2,
  });
  registerWorkbenchPanelTab({
    kind: "tasks",
    label: "侧边任务",
    icon: <ListTodo size={14} />,
    component: TaskPanel,
    order: 3,
  });
}
