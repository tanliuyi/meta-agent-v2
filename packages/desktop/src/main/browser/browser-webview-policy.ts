import type { WebContents } from "electron";
import { isBrowserSessionPartition } from "../../shared/browser-contracts.ts";

/**
 * Install the main-process policy for every webview attached to the app window.
 *
 * 每个会话使用独立分区（`persist:browser-<hash>`，见 browserPartitionFor）。
 * 分区由 renderer 按会话身份设置，这里只做格式白名单校验 + 安全加固；
 * 身份与分区的绑定由 BrowserManager.attach 在 main 侧校验（webContents 的
 * session 必须与会话身份对应的 partition session 一致）。
 */
export function installBrowserWebviewSecurity(webContents: WebContents): () => void {
  const onWillAttach = (
    event: Electron.Event,
    webPreferences: Electron.WebPreferences,
    params: Record<string, string>,
  ): void => {
    // Never allow an untrusted renderer to supply code that runs before the guest page.
    delete webPreferences.preload;
    delete params.preload;
    delete params.webpreferences;

    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;
    webPreferences.allowRunningInsecureContent = false;
    webPreferences.webviewTag = false;

    const partition = params.partition ?? "";
    if (!isBrowserSessionPartition(partition)) {
      event.preventDefault();
      return;
    }
    webPreferences.partition = partition;
    if (!isBrowserWebviewUrl(params.src)) {
      event.preventDefault();
    }
  };

  webContents.on("will-attach-webview", onWillAttach);
  return () => webContents.off("will-attach-webview", onWillAttach);
}

/** Initial URLs accepted by the browser guest. Later navigations are checked by BrowserManager. */
export function isBrowserWebviewUrl(raw: string | undefined): boolean {
  if (raw === "about:blank") return true;
  if (typeof raw !== "string" || raw.length === 0) return false;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
