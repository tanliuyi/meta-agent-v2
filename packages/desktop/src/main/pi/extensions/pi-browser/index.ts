/**
 * pi-browser：把内置浏览器（IAB）暴露为 Pi runtime 的 browser_* 工具集。
 *
 * 工具执行经 BrowserClient（本地 HTTP RPC，env: PI_BROWSER_HOST_PORT /
 * PI_BROWSER_TOKEN）调用 main 进程 BrowserManager，控制 renderer 侧
 * `<webview>` 的 guest webContents（导航/快照/点击/输入/滚动）。
 *
 * 用户与 Agent 共享同一视图（spec D6）：任何浏览器操作都在应用内可见。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createBrowserRunCodeCatalog,
  type RegisterBrowserToolsOptions,
  registerBrowserTools,
} from "./register-tools.ts";

export const runCodeCatalog = createBrowserRunCodeCatalog();

export default function piBrowser(pi: ExtensionAPI, options: RegisterBrowserToolsOptions = {}): void {
  registerBrowserTools(pi, options);
}
