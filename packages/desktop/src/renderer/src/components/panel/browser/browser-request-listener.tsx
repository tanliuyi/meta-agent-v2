import { useEffect } from "react";
import { useSessionScope, useSessionWorkbenchTabs } from "../../session-context.tsx";
import { registerBrowserRequestOwner } from "./browser-pending-requests.ts";

/**
 * 监听 main 进程的建 tab 请求（工具 browser.open 等触发），打开浏览器面板并
 * 缓冲请求。挂载在有 workbench tab 状态的容器内（SessionSurface 与新会话草稿
 * shell 均渲染 WorkbenchPanel）。
 *
 * 多会话场景下由模块级 owner registry 选定一个活动 Workbench 接收请求；原生事件在同一 renderer 窗口内只订阅一次，
 * 避免重复创建面板和 webview。
 */
export function BrowserRequestListener() {
  const { active } = useSessionScope();
  const tabs = useSessionWorkbenchTabs();
  useEffect(() => {
    if (!active) return;
    return registerBrowserRequestOwner(tabs);
  }, [active, tabs]);
  return null;
}
