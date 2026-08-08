import { Suspense } from "react";
import { LazyBrowserPanel } from "./lazy-browser-panel.tsx";

/** 浏览器面板懒加载入口：Suspense 兜底。
 * 无边界时 lazy 首次挂起会把整个 UI 替换为空白（React 报错原文 "the UI to be
 * replaced with a loading indicator"），表现为打开面板瞬间全窗口白屏后恢复；
 * fallback 只占面板区域。 */
export function BrowserPanelTab() {
  return (
    <Suspense fallback={<div className="sidebar-session-loading">浏览器加载中…</div>}>
      <LazyBrowserPanel />
    </Suspense>
  );
}
