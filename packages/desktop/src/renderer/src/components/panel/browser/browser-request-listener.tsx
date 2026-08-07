import { useCallback, useEffect } from "react";
import { browserSessionKey } from "../../../../../shared/browser-contracts.ts";
import { useSessionScope, useSessionWorkbenchTabs } from "../../session-context.tsx";
import { BROWSER_PANEL_KIND } from "../builtin-panel-kinds.ts";
import { subscribeBrowserCreateRequest } from "./browser-runtime-host.ts";

export function openBrowserPanel(
  updateWorkbench: (value: { panelOpen: true }) => void,
  openPanelTab: (panel: string) => void,
): void {
  updateWorkbench({ panelOpen: true });
  openPanelTab(BROWSER_PANEL_KIND);
}

/**
 * 监听本会话的建 tab 请求（工具 browser.open 等触发），打开浏览器面板并
 * 缓冲请求。挂载在有 workbench tab 状态的容器内（SessionSurface 与新会话草稿
 * shell 均渲染 WorkbenchPanel）。
 *
 * 多会话场景下按会话身份路由：只响应属于当前会话的请求；webview 的创建与
 * attach 由常驻 runtime host 完成（后台会话不要求面板打开）。原生事件在同一
 * renderer 窗口内只订阅一次（runtime host），这里只负责打开面板。
 */
export function BrowserRequestListener() {
  const { active, updateWorkbench, record } = useSessionScope();
  const tabs = useSessionWorkbenchTabs();
  const sessionKey = browserSessionKey(record.identity);
  const handleBrowserRequest = useCallback(
    () => openBrowserPanel(updateWorkbench, tabs.openPanelTab),
    [tabs.openPanelTab, updateWorkbench],
  );

  useEffect(() => {
    if (!active) return;
    return subscribeBrowserCreateRequest(sessionKey, handleBrowserRequest);
  }, [active, handleBrowserRequest, sessionKey]);
  return null;
}
